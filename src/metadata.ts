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
  SchemaConstraints,
} from './types.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

/**
 * Extract metadata from the bundled OpenAPI spec.
 */
export function extractMetadata(
  spec: Record<string, unknown>,
  schemas: Record<string, unknown>,
  specHash: string
): SpecMetadata {
  const semanticKeys = extractSemanticKeys(schemas);
  const unions = extractUnions(schemas);
  const arrays = extractArraySchemas(schemas);
  const { eventuallyConsistentOps, operations } = extractOperations(spec);

  return {
    schemaVersion: '1.0.0',
    specHash,
    semanticKeys: semanticKeys.sort((a, b) => a.name.localeCompare(b.name)),
    unions: unions.sort((a, b) => a.name.localeCompare(b.name)),
    arrays: arrays.sort((a, b) => a.name.localeCompare(b.name)),
    eventuallyConsistentOps,
    operations,
    integrity: {
      totalSemanticKeys: semanticKeys.length,
      totalUnions: unions.length,
      totalOperations: operations.length,
      totalEventuallyConsistent: eventuallyConsistentOps.length,
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

function extractOperations(spec: Record<string, unknown>): {
  eventuallyConsistentOps: EventuallyConsistentOp[];
  operations: OperationSummary[];
} {
  const eventuallyConsistentOps: EventuallyConsistentOp[] = [];
  const operations: OperationSummary[] = [];

  const paths = spec['paths'] as Record<string, unknown> | undefined;
  if (!paths) return { eventuallyConsistentOps, operations };

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathObj = pathItem as Record<string, unknown>;

    for (const method of HTTP_METHODS) {
      const op = pathObj[method] as Record<string, unknown> | undefined;
      if (!op) continue;

      const operationId = (op['operationId'] as string) || `${method}_${pathStr}`;
      const tags = (op['tags'] as string[]) || [];
      const summary = op['summary'] as string | undefined;

      const ecValue = op['x-eventually-consistent'];
      const eventuallyConsistent = ecValue === true;

      const hasRequestBody = !!op['requestBody'];
      let requestBodyUnion = false;
      if (hasRequestBody) {
        const rb = op['requestBody'] as Record<string, unknown>;
        const content = rb['content'] as Record<string, unknown> | undefined;
        if (content) {
          const jsonContent = content['application/json'] as
            | Record<string, unknown>
            | undefined;
          const schema = jsonContent?.['schema'] as
            | Record<string, unknown>
            | undefined;
          if (schema && (schema['oneOf'] || schema['anyOf'])) {
            requestBodyUnion = true;
          }
        }
      }

      operations.push({
        operationId,
        path: pathStr,
        method,
        tags,
        summary,
        eventuallyConsistent,
        hasRequestBody,
        requestBodyUnion,
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
