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
              // optionalTenantIdInBody: true only if ALL variants have optional tenantId
              const resolved = variants.map((v) => resolveSchemaRef(v, componentSchemas));
              if (resolved.length > 0 && resolved.every((rs) => rs && hasOptionalTenantId(rs))) {
                optionalTenantIdInBody = true;
              }
            } else {
              const resolved = resolveSchemaRef(schema, componentSchemas);
              if (resolved && hasOptionalTenantId(resolved)) {
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

/** Check if a resolved schema has an optional tenantId property. */
function hasOptionalTenantId(schema: Record<string, unknown>): boolean {
  if (schema['type'] !== 'object') return false;
  const props = schema['properties'] as Record<string, unknown> | undefined;
  if (!props || !props['tenantId']) return false;
  const required = (schema['required'] as string[] | undefined) ?? [];
  return !required.includes('tenantId');
}
