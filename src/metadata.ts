/**
 * Extract domain metadata (intermediate representation) from the bundled spec.
 *
 * This produces a generator-agnostic IR capturing:
 * - Semantic key types (x-semantic-type, x-semantic-key)
 * - Union/variant types (oneOf/anyOf structures)
 * - Array schemas with bounds
 * - Eventually consistent operations
 * - Operation summaries
 */
import type {
  SpecMetadata,
  SemanticKeyEntry,
  UnionEntry,
  UnionBranch,
  ArraySchemaEntry,
  EventuallyConsistentOp,
  OperationSummary,
  OperationQueryParam,
  SchemaConstraints,
  DeprecatedEnumSchemaEntry,
  DeprecatedEnumMemberEntry,
  SemanticProviderEntry,
} from './types.js';
import { jsonPointerDecode } from './helpers.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

/**
 * Extract metadata from the bundled OpenAPI spec.
 */
export function extractMetadata(
  spec: Record<string, unknown>,
  schemas: Record<string, unknown>,
  specHash: string,
  sourceFileByOp?: Map<string, string>
): SpecMetadata {
  const semanticKeys = extractSemanticKeys(schemas);
  const unions = extractUnions(schemas);
  const arrays = extractArraySchemas(schemas);
  const { eventuallyConsistentOps, operations } = extractOperations(
    spec,
    sourceFileByOp
  );
  const deprecatedEnumMembers = extractDeprecatedEnumMembers(schemas);
  const semanticProviders = extractSemanticProviders(schemas);

  return {
    schemaVersion: '2.0.0',
    specHash,
    semanticKeys: semanticKeys.sort((a, b) => a.name.localeCompare(b.name)),
    unions: unions.sort((a, b) => a.name.localeCompare(b.name)),
    arrays: arrays.sort((a, b) => a.name.localeCompare(b.name)),
    eventuallyConsistentOps,
    operations,
    deprecatedEnumMembers: deprecatedEnumMembers.sort((a, b) => a.schemaName.localeCompare(b.schemaName)),
    semanticProviders: semanticProviders.sort((a, b) => a.schemaName.localeCompare(b.schemaName)),
    integrity: {
      totalSemanticKeys: semanticKeys.length,
      totalUnions: unions.length,
      totalOperations: operations.length,
      totalEventuallyConsistent: eventuallyConsistentOps.length,
      totalDeprecatedEnumSchemas: deprecatedEnumMembers.length,
      totalSemanticProviders: semanticProviders.length,
    },
  };
}

function toStableId(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function extractConstraints(obj: Record<string, unknown>): SchemaConstraints {
  const c: SchemaConstraints = {};
  if (typeof obj['pattern'] === 'string') c.pattern = obj['pattern'];
  if (typeof obj['minLength'] === 'number') c.minLength = obj['minLength'];
  if (typeof obj['maxLength'] === 'number') c.maxLength = obj['maxLength'];
  if (typeof obj['format'] === 'string') c.format = obj['format'];
  return c;
}

function mergeConstraints(
  target: SchemaConstraints,
  extra: SchemaConstraints
): void {
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined)
      (target as Record<string, unknown>)[k] = v;
  }
}

/**
 * Resolve the effective scalar `type` of a (possibly `allOf`-composed) schema,
 * following a `$ref` to `LongKey` (which is `type: string`). Returns the
 * discovered scalar type, or `undefined` when no explicit type is present.
 *
 * Used to gate semantic-key classification: SDKs model semantic keys as branded
 * strings (`CamundaKey<T>`), so a schema tagged with `x-semantic-type`/
 * `x-semantic-key` whose resolved type is non-string (e.g. the client-minted
 * `IterationId`, `type: integer`) must not be treated as a string key.
 */
function resolveScalarType(
  schema: Record<string, unknown>,
  schemas: Record<string, unknown>
): string | undefined {
  if (typeof schema['type'] === 'string') return schema['type'] as string;

  if (Array.isArray(schema['allOf'])) {
    for (const part of schema['allOf'] as Record<string, unknown>[]) {
      if (typeof part['type'] === 'string') return part['type'] as string;
      const ref = part['$ref'];
      if (typeof ref === 'string') {
        const refName = ref.split('/').pop();
        const target =
          refName && (schemas[refName] as Record<string, unknown> | undefined);
        if (target && typeof target['type'] === 'string')
          return target['type'] as string;
      }
    }
  }

  return undefined;
}

function extractSemanticKeys(
  schemas: Record<string, unknown>
): SemanticKeyEntry[] {
  const keys: SemanticKeyEntry[] = [];
  const longKey = schemas['LongKey'] as Record<string, unknown> | undefined;

  for (const [name, rawSchema] of Object.entries(schemas)) {
    if (name === 'LongKey' || name === 'CamundaKey') continue;

    const schema = rawSchema as Record<string, unknown>;
    const isAllOf = Array.isArray(schema['allOf']);
    const isOneOf = Array.isArray(schema['oneOf']);
    const isAnyOf = Array.isArray(schema['anyOf']);

    // Skip unions — handled separately
    if (isOneOf || isAnyOf) continue;

    const semanticKey =
      schema['x-semantic-key'] === true || !!schema['x-semantic-type'];
    if (!semanticKey) continue;

    // Semantic keys are modelled by the SDKs as branded *strings*
    // (CamundaKey<T>). A schema tagged with x-semantic-type/x-semantic-key
    // whose resolved type is a non-string scalar (e.g. the client-minted
    // `IterationId`, type: integer) is not a string key and must be left as a
    // plain numeric/boolean type — otherwise the generators emit string-typed
    // brand helpers over a numeric alias, producing a type error downstream.
    const resolvedType = resolveScalarType(schema, schemas);
    if (resolvedType && resolvedType !== 'string') continue;

    let includesLongKeyRef = false;
    const constraints: SchemaConstraints = {};
    let inlineFragments = 0;
    let schemaKind: SemanticKeyEntry['composition']['schemaKind'] = 'inline';
    const description = schema['description'] as string | undefined;
    let examples: string[] | undefined;

    if (schema['example']) examples = [String(schema['example'])];

    if (isAllOf) {
      schemaKind = 'allOf';
      for (const part of schema['allOf'] as Record<string, unknown>[]) {
        if (part['$ref'] === '#/components/schemas/LongKey')
          includesLongKeyRef = true;
        if (!part['$ref']) {
          inlineFragments++;
          mergeConstraints(constraints, extractConstraints(part));
          if (part['example'])
            (examples ??= []).push(String(part['example']));
        }
      }
    } else {
      mergeConstraints(constraints, extractConstraints(schema));
    }

    // Inherit LongKey constraints when schema is a pure ref alias
    if (includesLongKeyRef && Object.keys(constraints).length === 0 && longKey) {
      mergeConstraints(constraints, extractConstraints(longKey));
    }

    let category: SemanticKeyEntry['category'] = 'system-key';
    if (/Cursor$/i.test(name)) category = 'cursor';
    else if (/Id$/i.test(name)) category = 'model-id';
    else if (!includesLongKeyRef && !constraints.pattern) category = 'other';

    keys.push({
      name,
      semanticType: (schema['x-semantic-type'] as string) || name,
      category,
      description,
      composition: {
        schemaKind,
        refs: includesLongKeyRef ? ['LongKey'] : [],
        inlineFragments,
      },
      constraints,
      examples,
      extensions: {
        'x-semantic-type': schema['x-semantic-type'] as string | undefined,
        'x-semantic-key': schema['x-semantic-key'] as boolean | undefined,
      },
      flags: {
        semanticKey,
        includesLongKeyRef,
        deprecated: !!schema['deprecated'],
      },
      stableId: toStableId(name),
    });
  }

  return keys;
}

function extractUnions(schemas: Record<string, unknown>): UnionEntry[] {
  const unions: UnionEntry[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = rawSchema as Record<string, unknown>;
    const isOneOf = Array.isArray(schema['oneOf']);
    const isAnyOf = Array.isArray(schema['anyOf']);

    if (!isOneOf && !isAnyOf) continue;

    const list = (schema['oneOf'] || schema['anyOf']) as Record<
      string,
      unknown
    >[];
    const branches: UnionBranch[] = [];

    for (const b of list) {
      if (b['$ref']) {
        const refName = (b['$ref'] as string).split('/').pop()!;
        branches.push({ branchType: 'ref', ref: refName });
      } else if (Array.isArray(b['allOf'])) {
        const compRefs: string[] = [];
        for (const part of b['allOf'] as Record<string, unknown>[]) {
          if (part['$ref'])
            compRefs.push((part['$ref'] as string).split('/').pop()!);
        }
        branches.push({ branchType: 'composed', refs: compRefs });
      } else if (b['type'] === 'string' && b['format'] === 'uuid') {
        branches.push({
          branchType: 'uuid',
          constraints: { format: 'uuid' },
        });
      } else {
        branches.push({ branchType: 'other' });
      }
    }

    const allRefs = branches.every((br) => br.branchType === 'ref');
    unions.push({
      name,
      kind: allRefs ? 'union-wrapper' : 'hybrid-union',
      description: schema['description'] as string | undefined,
      branches,
      stableId: toStableId(name),
    });
  }

  return unions;
}

function extractArraySchemas(
  schemas: Record<string, unknown>
): ArraySchemaEntry[] {
  const arrays: ArraySchemaEntry[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = rawSchema as Record<string, unknown>;
    if (schema['type'] !== 'array') continue;

    const items = schema['items'] as Record<string, unknown> | undefined;
    arrays.push({
      name,
      itemRef: items?.['$ref']
        ? String(items['$ref']).split('/').pop()
        : undefined,
      itemType: items?.['type'] as string | undefined,
      minItems:
        typeof schema['minItems'] === 'number'
          ? schema['minItems']
          : undefined,
      maxItems:
        typeof schema['maxItems'] === 'number'
          ? schema['maxItems']
          : undefined,
      uniqueItems: !!schema['uniqueItems'],
    });
  }

  return arrays;
}

function extractDeprecatedEnumMembers(
  schemas: Record<string, unknown>
): DeprecatedEnumSchemaEntry[] {
  const results: DeprecatedEnumSchemaEntry[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = rawSchema as Record<string, unknown>;
    const deprecatedList = schema['x-deprecated-enum-members'];
    if (!Array.isArray(deprecatedList) || deprecatedList.length === 0) continue;

    const enumValues = Array.isArray(schema['enum'])
      ? (schema['enum'] as string[])
      : [];

    const deprecatedMembers: DeprecatedEnumMemberEntry[] = [];
    for (const entry of deprecatedList) {
      if (!entry || typeof entry !== 'object') continue;
      const memberName = (entry as Record<string, unknown>)['name'];
      const version = (entry as Record<string, unknown>)['deprecatedInVersion'];
      if (typeof memberName === 'string') {
        deprecatedMembers.push({
          name: memberName,
          deprecatedInVersion: typeof version === 'string' ? version : 'unknown',
        });
      }
    }

    if (deprecatedMembers.length > 0) {
      results.push({
        schemaName: name,
        enumValues,
        deprecatedMembers,
        stableId: toStableId(name),
      });
    }
  }

  return results;
}

function extractSemanticProviders(
  schemas: Record<string, unknown>
): SemanticProviderEntry[] {
  const results: SemanticProviderEntry[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = rawSchema as Record<string, unknown>;
    const providers = schema['x-semantic-provider'];
    if (!Array.isArray(providers) || providers.length === 0) continue;

    const validProviders = providers.filter(
      (p): p is string => typeof p === 'string'
    );
    if (validProviders.length === 0) continue;

    results.push({
      schemaName: name,
      providers: validProviders,
      stableId: toStableId(name),
    });
  }

  return results;
}

function extractOperations(
  spec: Record<string, unknown>,
  sourceFileByOp?: Map<string, string>
): {
  eventuallyConsistentOps: EventuallyConsistentOp[];
  operations: OperationSummary[];
} {
  const eventuallyConsistentOps: EventuallyConsistentOp[] = [];
  const operations: OperationSummary[] = [];

  const paths = spec['paths'] as Record<string, unknown> | undefined;
  if (!paths) return { eventuallyConsistentOps, operations };

  const componentSchemas = (
    (spec['components'] as Record<string, unknown> | undefined)?.['schemas'] as
      | Record<string, unknown>
      | undefined
  ) ?? {};
  const componentRequestBodies = (
    (spec['components'] as Record<string, unknown> | undefined)?.[
      'requestBodies'
    ] as Record<string, unknown> | undefined
  ) ?? {};
  const componentResponses = (
    (spec['components'] as Record<string, unknown> | undefined)?.[
      'responses'
    ] as Record<string, unknown> | undefined
  ) ?? {};

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathObj = pathItem as Record<string, unknown>;

    for (const method of HTTP_METHODS) {
      const op = pathObj[method] as Record<string, unknown> | undefined;
      if (!op) continue;

      const operationId = (op['operationId'] as string) || `${method}_${pathStr}`;
      const tags = (op['tags'] as string[]) || [];
      const summary = op['summary'] as string | undefined;
      const description = op['description'] as string | undefined;

      const ecValue = op['x-eventually-consistent'];
      const eventuallyConsistent = ecValue === true;

      // Parameters
      const rawParams = (op['parameters'] as Record<string, unknown>[] | undefined) ?? [];
      const pathParams: string[] = [];
      const queryParams: OperationQueryParam[] = [];
      for (const p of rawParams) {
        const pIn = p['in'] as string | undefined;
        const pName = p['name'] as string | undefined;
        if (!pName) continue;
        if (pIn === 'path') pathParams.push(pName);
        else if (pIn === 'query') queryParams.push({ name: pName, required: !!p['required'] });
      }

      const hasRequestBody = !!op['requestBody'];
      let requestBodyUnion = false;
      const requestBodyUnionRefs: string[] = [];
      let optionalTenantIdInBody = false;
      const requestBodyContentTypes: string[] = [];
      let requestBodySchemaRef: string | undefined;

      if (hasRequestBody) {
        // Resolve `requestBody` itself if it points at
        // `#/components/requestBodies/...` so that the rest of this block
        // sees the actual content map.
        const rb = resolveComponentRef(
          op['requestBody'] as Record<string, unknown>,
          componentRequestBodies
        );
        const content = rb?.['content'] as Record<string, unknown> | undefined;
        if (content) {
          for (const ct of Object.keys(content)) {
            requestBodyContentTypes.push(ct);
          }
          // First content entry whose schema is a $ref wins. Inline schemas
          // do not block later $ref entries.
          for (const mediaObj of Object.values(content)) {
            const media = mediaObj as Record<string, unknown> | undefined;
            const rawSchema = media?.['schema'] as Record<string, unknown> | undefined;
            const ref = rawSchema?.['$ref'];
            if (typeof ref === 'string') {
              requestBodySchemaRef = ref.split('/').pop();
              break;
            }
          }
          // Check all JSON-like content types
          for (const [contentType, mediaObj] of Object.entries(content)) {
            if (!/json|octet|multipart|text\//i.test(contentType)) continue;
            const media = mediaObj as Record<string, unknown> | undefined;
            const rawSchema = media?.['schema'] as Record<string, unknown> | undefined;
            if (!rawSchema) continue;

            // Resolve top-level $ref to get the actual schema (e.g. { $ref: '...Instruction' } → the Instruction schema)
            const schema = resolveSchemaRef(rawSchema, componentSchemas) ?? rawSchema;

            const variants = (schema['oneOf'] || schema['anyOf']) as
              | Record<string, unknown>[]
              | undefined;
            if (Array.isArray(variants) && variants.length > 1) {
              requestBodyUnion = true;
              for (const v of variants) {
                if (v['$ref'] && typeof v['$ref'] === 'string') {
                  const refName = (v['$ref'] as string).split('/').pop()!;
                  requestBodyUnionRefs.push(refName);
                }
              }
              // optionalTenantIdInBody: true only if ALL variants have optional
              // tenantId. Each variant is evaluated together with the
              // wrapper's own properties/required/allOf, which apply to every
              // variant (a wrapper-level `required: [tenantId]` makes it
              // mandatory throughout). Evaluate EVERY variant before
              // aggregating: a short-circuiting `every` would spare later
              // variants from validation, making unresolved/cyclic refs
              // order-dependent.
              const variantResults = variants.map((v) =>
                hasOptionalTenantId([schema, v], componentSchemas)
              );
              if (variantResults.every(Boolean)) {
                optionalTenantIdInBody = true;
              }
            } else {
              if (hasOptionalTenantId([schema], componentSchemas)) {
                optionalTenantIdInBody = true;
              }
            }
          }
        }
      }

      const bodyOnly = hasRequestBody && pathParams.length === 0 && queryParams.length === 0;

      // Success response: pick the lowest 2xx status, then look for an
      // application/json schema $ref under it.
      let successStatus: number | undefined;
      let successResponseSchemaRef: string | undefined;
      const responses = op['responses'] as Record<string, unknown> | undefined;
      if (responses) {
        const statuses = Object.keys(responses)
          .map((k) => ({ key: k, num: Number(k) }))
          .filter(({ num }) => Number.isInteger(num) && num >= 200 && num < 300)
          .sort((a, b) => a.num - b.num);
        if (statuses.length > 0) {
          successStatus = statuses[0].num;
          // Resolve `responses[<status>]` if it points at
          // `#/components/responses/...` so a factored-out response still
          // exposes its content schema $ref.
          const resp = resolveComponentRef(
            responses[statuses[0].key] as Record<string, unknown> | undefined,
            componentResponses
          );
          const respContent = resp?.['content'] as
            | Record<string, unknown>
            | undefined;
          if (respContent) {
            const json = respContent['application/json'] as
              | Record<string, unknown>
              | undefined;
            const schema = json?.['schema'] as
              | Record<string, unknown>
              | undefined;
            const ref = schema?.['$ref'];
            if (typeof ref === 'string') {
              successResponseSchemaRef = ref.split('/').pop();
            }
          }
        }
      }

      // Vendor extensions: pass through every x-* key on the operation.
      // Deep-clone object/array values so the metadata IR stays independent
      // of the bundled spec (mutating one must not affect the other).
      let vendorExtensions: Record<string, unknown> | undefined;
      for (const k of Object.keys(op)) {
        if (k.startsWith('x-')) {
          if (!vendorExtensions) vendorExtensions = {};
          const v = op[k];
          vendorExtensions[k] =
            v !== null && typeof v === 'object' ? structuredClone(v) : v;
        }
      }

      const sourceFile = sourceFileByOp?.get(`${method} ${pathStr}`) ?? '';

      operations.push({
        operationId,
        path: pathStr,
        method,
        tags,
        summary,
        description,
        eventuallyConsistent,
        hasRequestBody,
        requestBodyUnion,
        bodyOnly,
        pathParams,
        queryParams,
        requestBodyUnionRefs,
        optionalTenantIdInBody,
        sourceFile,
        requestBodyContentTypes,
        requestBodySchemaRef,
        successResponseSchemaRef,
        successStatus,
        vendorExtensions,
      });

      if (eventuallyConsistent) {
        eventuallyConsistentOps.push({
          operationId,
          path: pathStr,
          method,
          tags,
        });
      }
    }
  }

  return { eventuallyConsistentOps, operations };
}

/** Resolve a single $ref to a component schema, or return the schema itself. */
function resolveSchemaRef(
  schema: Record<string, unknown>,
  componentSchemas: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (schema['$ref'] && typeof schema['$ref'] === 'string') {
    const name = (schema['$ref'] as string).split('/').pop()!;
    return componentSchemas[name] as Record<string, unknown> | undefined;
  }
  return schema;
}

/**
 * Resolve a `$ref` that targets a `#/components/<bucket>/<name>` entry
 * (e.g. `requestBodies`, `responses`). Returns the original object when it
 * is not a `$ref`, or `undefined` when the ref cannot be resolved against
 * the supplied component bucket.
 */
function resolveComponentRef(
  obj: Record<string, unknown> | undefined,
  componentBucket: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const ref = obj['$ref'];
  if (typeof ref !== 'string') return obj;
  const name = ref.split('/').pop()!;
  return componentBucket[name] as Record<string, unknown> | undefined;
}

/**
 * Check whether tenantId is optional across a set of schemas that all apply to
 * the same instance: a single body schema, or a union wrapper plus one of its
 * variants (the wrapper's constraints apply to every variant).
 *
 * Walks each schema together with its own `$ref` (component aliases) and its
 * `allOf` members (by `$ref` or inline), recursively. That is where composed
 * request bodies inherit `tenantId` from a shared base (#47).
 * A `oneOf`/`anyOf` reached through this walk still constrains the body —
 * every instance matches one of its branches — so the flag is computed per
 * branch under the enclosing constraints and must hold for EVERY branch
 * (a branch that requires `tenantId`, or never declares it, makes it
 * non-optional overall). Every branch is validated before aggregating, so an
 * unresolved or cyclic branch `$ref` throws regardless of position.
 * `tenantId` is optional when some level declares it under `properties` and no
 * level lists it in `required`. At least one level must be `type: object`.
 *
 * Throws on a `$ref` that is not a resolvable `#/components/schemas/` pointer
 * (component names are decoded before lookup — URI decoding plus JSON Pointer
 * escapes, e.g. `Base%2EName` → `Base.Name`, `Base~0Name` → `Base~Name`), or a
 * cyclic chain: either means the flag cannot be computed, and guessing
 * would silently change SDK behaviour.
 */
function hasOptionalTenantId(
  schemas: Record<string, unknown>[],
  componentSchemas: Record<string, unknown>
): boolean {
  const prefix = '#/components/schemas/';

  const follow = (ref: string, chain: string[]): Record<string, unknown> => {
    if (chain.includes(ref)) {
      throw new Error(
        `Cyclic $ref chain while computing optionalTenantIdInBody: ` +
          `${[...chain, ref].join(' -> ')}`
      );
    }
    // Only `#/components/schemas/<name>` is resolvable here. The name segment
    // may be URI-encoded and carry JSON Pointer escapes (RFC 6901: `~0` = `~`,
    // `~1` = `/`), so decode both before lookup — `Base%2EName` targets
    // `Base.Name`, `Base~0Name` targets `Base~Name`. Reject anything with
    // further path segments rather than silently matching on the last one: an
    // interior pointer means the flag cannot be computed, and guessing would
    // silently change SDK behaviour.
    const rest = ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
    const name = rest !== undefined && !rest.includes('/') ? jsonPointerDecode(rest) : undefined;
    const target = name !== undefined ? componentSchemas[name] : undefined;
    if (!target || typeof target !== 'object') {
      throw new Error(
        `$ref ${ref} does not resolve to a component schema while ` +
          `computing optionalTenantIdInBody (chain: ${[...chain, ref].join(' -> ')})`
      );
    }
    return target as Record<string, unknown>;
  };

  /**
   * Conjunctive walk: `node`'s own constraints plus everything that applies to
   * every instance alongside it — its own `$ref` (component alias) and its
   * `allOf` members — returning what that subtree establishes about tenantId.
   * A nested `oneOf`/`anyOf` still constrains the body (every instance matches
   * one branch), so the flag must hold for EVERY branch under the enclosing
   * constraints; a branch that cannot guarantee an optional tenantId vetoes
   * the whole union. Every branch is walked before aggregating, so an
   * unresolved or cyclic branch `$ref` throws regardless of position.
   */
  interface WalkState {
    isObject: boolean;
    declared: boolean;
    required: boolean;
  }
  const walk = (node: Record<string, unknown>, chain: string[]): WalkState => {
    let isObject = node['type'] === 'object';
    const props = node['properties'] as Record<string, unknown> | undefined;
    let declared = !!(props && props['tenantId']);
    const req = node['required'];
    let required = Array.isArray(req) && req.includes('tenantId');

    const ownRef = node['$ref'];
    if (typeof ownRef === 'string') {
      const r = walk(follow(ownRef, chain), [...chain, ownRef]);
      isObject ||= r.isObject;
      declared ||= r.declared;
      required ||= r.required;
    }

    const allOf = node['allOf'];
    if (Array.isArray(allOf)) {
      for (const member of allOf as Record<string, unknown>[]) {
        if (member && typeof member === 'object') {
          const r = walk(member, chain);
          isObject ||= r.isObject;
          declared ||= r.declared;
          required ||= r.required;
        }
      }
    }

    // Evaluate a nested union LAST, against the complete enclosing state:
    // every sibling conjunct applies to whichever branch an instance matches,
    // no matter where the union sits among them.
    const union = (node['oneOf'] || node['anyOf']) as
      | Record<string, unknown>[]
      | undefined;
    if (Array.isArray(union)) {
      const enclosing: WalkState = { isObject, declared, required };
      const branchResults = union.map((branch) => {
        if (!branch || typeof branch !== 'object') return false;
        const b = walk(branch, chain);
        return (
          (b.isObject || enclosing.isObject) &&
          (b.declared || enclosing.declared) &&
          !b.required &&
          !enclosing.required
        );
      });
      if (branchResults.every(Boolean)) {
        // Every branch guarantees an optional tenantId under the enclosing
        // constraints, so the union establishes the flag for this node too.
        isObject = true;
        declared = true;
      } else {
        // A branch that cannot guarantee an optional tenantId vetoes the
        // whole union: some instance of this node may lack it (or must
        // supply it), so the flag cannot be reported for this node.
        required = true;
      }
    }

    return { isObject, declared, required };
  };

  let isObject = false;
  let declared = false;
  let required = false;
  for (const schema of schemas) {
    const r = walk(schema, []);
    isObject ||= r.isObject;
    declared ||= r.declared;
    required ||= r.required;
  }
  return isObject && declared && !required;
}
