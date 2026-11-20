import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../src/metadata.js';

/**
 * `optionalTenantIdInBody` must see `tenantId` wherever JSON Schema puts it on
 * the object: directly in `properties`, or inherited through `allOf` (#47).
 *
 * `createProcessInstance` is a `oneOf` of variants that each inherit an
 * optional `tenantId` from a shared base through `allOf`. Before #47 the
 * detector only read a schema's own `properties` and reported `false`, so the
 * TypeScript SDK added its own detector as a workaround
 * (camunda/orchestration-cluster-api-js#648).
 *
 * Class-scoped: covers union and non-union bodies, `$ref` and inline `allOf`
 * members, nesting, and `required` declared at any level.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function bodyOp(operationId: string, schemaName: string) {
  return {
    post: {
      operationId,
      requestBody: {
        content: { 'application/json': { schema: ref(schemaName) } },
      },
      responses: { '200': { description: 'OK' } },
    },
  };
}

function optionalTenantIdInBody(
  schemas: Record<string, unknown>,
  bodySchema: string
): boolean {
  const spec = {
    openapi: '3.0.3',
    paths: { '/op': bodyOp('op', bodySchema) },
    components: { schemas },
  };
  const md = extractMetadata(spec, schemas, 'sha256:test');
  const op = md.operations.find((o) => o.operationId === 'op');
  if (!op) throw new Error('fixture operation not extracted');
  return op.optionalTenantIdInBody;
}

const Base = {
  type: 'object',
  properties: { tenantId: { type: 'string' }, variables: { type: 'object' } },
};

describe('optionalTenantIdInBody through allOf (#47)', () => {
  it('is true for a oneOf of allOf variants inheriting an optional tenantId (createProcessInstance shape)', () => {
    const schemas = {
      Base,
      ByKey: {
        type: 'object',
        required: ['processDefinitionKey'],
        allOf: [ref('Base')],
        properties: { processDefinitionKey: { type: 'string' } },
      },
      ById: {
        type: 'object',
        required: ['processDefinitionId'],
        allOf: [ref('Base')],
        properties: { processDefinitionId: { type: 'string' } },
      },
      Instruction: { oneOf: [ref('ByKey'), ref('ById')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Instruction')).toBe(true);
  });

  it('is true for a non-union body inheriting tenantId through allOf', () => {
    const schemas = { Base, Req: { allOf: [ref('Base')] } };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
  });

  it('follows inline allOf members and nested allOf chains', () => {
    const schemas = {
      Base,
      Mid: { allOf: [ref('Base')] },
      Req: {
        allOf: [ref('Mid'), { type: 'object', properties: { x: { type: 'string' } } }],
      },
      Inline: {
        allOf: [{ type: 'object', properties: { tenantId: { type: 'string' } } }],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
    expect(optionalTenantIdInBody(schemas, 'Inline')).toBe(true);
  });

  it('is false when the variant requires the inherited tenantId', () => {
    const schemas = {
      Base,
      Req: { allOf: [ref('Base')], required: ['tenantId'] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('is false when the base requires tenantId', () => {
    const schemas = {
      Base: { ...Base, required: ['tenantId'] },
      Req: { allOf: [ref('Base')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('is false when a sibling allOf member requires tenantId', () => {
    const schemas = {
      Base,
      Req: { allOf: [ref('Base'), { required: ['tenantId'] }] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('is false for a union when any variant lacks tenantId', () => {
    const schemas = {
      Base,
      WithTenant: { allOf: [ref('Base')] },
      WithoutTenant: { type: 'object', properties: { x: { type: 'string' } } },
      Instruction: { oneOf: [ref('WithTenant'), ref('WithoutTenant')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Instruction')).toBe(false);
  });

  it('throws on an allOf $ref that does not resolve, naming it', () => {
    const schemas = { Req: { allOf: [ref('Missing')] } };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(
      /#\/components\/schemas\/Missing/
    );
  });

  it('throws on an allOf $ref that is not a component schema, rather than matching by last segment', () => {
    // `Base` exists, but this pointer does not address it.
    const schemas = {
      Base,
      Req: { allOf: [{ $ref: '#/paths/~1op/post/Base' }] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(
      /#\/paths\/~1op\/post\/Base/
    );
  });

  it('throws on a cyclic allOf chain rather than looping', () => {
    const schemas = {
      A: { allOf: [ref('B')] },
      B: { allOf: [ref('A')] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'A')).toThrow(/cycl/i);
  });

  // Review on #48: the union wrapper's own constraints apply to every variant.
  it('is false for a union whose wrapper requires tenantId', () => {
    const schemas = {
      Base,
      V1: { allOf: [ref('Base')] },
      V2: { allOf: [ref('Base')] },
      Instruction: { required: ['tenantId'], oneOf: [ref('V1'), ref('V2')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Instruction')).toBe(false);
  });

  it('is false for a union whose wrapper allOf requires tenantId', () => {
    const schemas = {
      Base,
      V1: { allOf: [ref('Base')] },
      V2: { allOf: [ref('Base')] },
      Instruction: {
        allOf: [{ required: ['tenantId'] }],
        oneOf: [ref('V1'), ref('V2')],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Instruction')).toBe(false);
  });

  it('is true for a union whose wrapper declares an optional tenantId the variants share', () => {
    const schemas = {
      V1: { type: 'object', properties: { a: { type: 'string' } } },
      V2: { type: 'object', properties: { b: { type: 'string' } } },
      Instruction: {
        type: 'object',
        properties: { tenantId: { type: 'string' } },
        oneOf: [ref('V1'), ref('V2')],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Instruction')).toBe(true);
  });

  it('throws on a union variant $ref that does not resolve', () => {
    const schemas = { Base, V1: { allOf: [ref('Base')] }, U: { oneOf: [ref('V1'), ref('Gone')] } };
    expect(() => optionalTenantIdInBody(schemas, 'U')).toThrow(/#\/components\/schemas\/Gone/);
  });

  // Review on #48: a node may itself be a $ref alias to another component.
  it('follows a component $ref alias reached through allOf', () => {
    const schemas = {
      Base,
      BaseAlias: ref('Base'),
      Req: { allOf: [ref('BaseAlias')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
  });

  it('sees a requirement declared behind an alias', () => {
    const schemas = {
      Base,
      Strict: { allOf: [ref('Base')], required: ['tenantId'] },
      StrictAlias: ref('Strict'),
      Req: { allOf: [ref('StrictAlias')] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('throws on an alias whose target does not resolve', () => {
    const schemas = { Alias: ref('Gone'), Req: { allOf: [ref('Alias')] } };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/#\/components\/schemas\/Gone/);
  });

  it('throws on a cyclic alias chain', () => {
    const schemas = { A: ref('B'), B: ref('A'), Req: { allOf: [ref('A')] } };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/cycl/i);
  });

  // Review on #48: `every` must not short-circuit — a nonqualifying variant
  // must not spare later variants from validation (order-independent).
  it('throws on an unresolved variant $ref even when a nonqualifying variant comes first', () => {
    const schemas = {
      V1: { type: 'object', properties: { a: { type: 'string' } } },
      U: { oneOf: [ref('V1'), ref('Gone')] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'U')).toThrow(/#\/components\/schemas\/Gone/);
  });

  it('throws on a cyclic variant $ref even when a nonqualifying variant comes first', () => {
    const schemas = {
      V1: { type: 'object', properties: { a: { type: 'string' } } },
      A: ref('B'),
      B: ref('A'),
      U: { oneOf: [ref('V1'), ref('A')] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'U')).toThrow(/cycl/i);
  });

  it('throws on a non-component variant $ref even when a nonqualifying variant comes first', () => {
    const schemas = {
      V1: { type: 'object', properties: { a: { type: 'string' } } },
      U: { oneOf: [ref('V1'), { $ref: './other.yaml#/Base' }] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'U')).toThrow(/other\.yaml/);
  });

  it('is true when every variant qualifies, regardless of order', () => {
    const schemas = {
      Base,
      WithTenant: { allOf: [ref('Base')] },
      Plain: { allOf: [ref('Base')] },
      U: { oneOf: [ref('WithTenant'), ref('Plain')] },
    };
    expect(optionalTenantIdInBody(schemas, 'U')).toBe(true);
  });

  // Review on #48: component names may be URI-encoded in the pointer.
  it('resolves a component $ref whose name is URI-encoded', () => {
    const schemas = {
      'Base.Name': Base,
      Req: { allOf: [{ $ref: '#/components/schemas/Base%2EName' }] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
  });

  it('resolves a URI-encoded component $ref at the top level', () => {
    const schemas = { 'Base.Name': Base };
    expect(optionalTenantIdInBody(schemas, 'Base%2EName')).toBe(true);
  });

  it('throws on a component $ref with extra path segments after the name', () => {
    const schemas = {
      Base,
      Req: { allOf: [{ $ref: '#/components/schemas/Base/properties/tenantId' }] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(
      /#\/components\/schemas\/Base\/properties\/tenantId/
    );
  });

  it('throws on an encoded name that decodes to no component', () => {
    const schemas = {
      Base,
      Req: { allOf: [{ $ref: '#/components/schemas/Gone%2EName' }] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/Gone%2EName/);
  });

  // Review on #48: a component name may itself contain `~` or `/`, spelled in
  // the pointer with JSON Pointer escapes (RFC 6901: `~0` = `~`, `~1` = `/`).
  it('resolves a component $ref whose name carries JSON Pointer escapes', () => {
    const schemas = {
      'Base~Name': Base,
      'Org/Schema': Base,
      Req: { allOf: [{ $ref: '#/components/schemas/Base~0Name' }] },
      ReqSlash: { allOf: [{ $ref: '#/components/schemas/Org~1Schema' }] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
    expect(optionalTenantIdInBody(schemas, 'ReqSlash')).toBe(true);
  });

  it('resolves a JSON Pointer–escaped component $ref at the top level', () => {
    const schemas = { 'Base~Name': Base };
    expect(optionalTenantIdInBody(schemas, 'Base~0Name')).toBe(true);
  });

  it('throws on a JSON Pointer–escaped name that decodes to no component', () => {
    const schemas = {
      Base,
      Req: { allOf: [{ $ref: '#/components/schemas/Gone~0Name' }] },
    };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/Gone~0Name/);
  });

  // Review on #48: RFC 6901 §6 — URI-decode the fragment BEFORE unescaping
  // pointer tokens, so `%7E1` means `~1` → `/`, never a literal `~1`.
  it('URI-decodes before unescaping pointer tokens', () => {
    const schemas = {
      'Org/Schema': Base,
      'Org~1Schema': { type: 'object', properties: { tenantId: { type: 'string' } }, required: ['tenantId'] },
      Req: { allOf: [{ $ref: '#/components/schemas/Org%7E1Schema' }] },
      ReqTilde: { allOf: [{ $ref: '#/components/schemas/Org%7E01Schema' }] },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
    expect(optionalTenantIdInBody(schemas, 'ReqTilde')).toBe(false);
  });

  it('rejects a URI-encoded slash as an interior pointer', () => {
    const schemas = { Base, Req: { allOf: [{ $ref: '#/components/schemas/Org%2FSchema' }] } };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/Org%2FSchema/);
  });

  // Review on #48: a union nested inside allOf still constrains the body —
  // every instance matches one branch, so a branch that requires tenantId (or
  // never declares it) makes it non-optional overall.
  it('is false when a union nested in allOf has a branch that requires tenantId', () => {
    const schemas = {
      Base,
      // Named: a qualifying variant must have a component name (#54).
      Opt: { type: 'object', properties: { tenantId: { type: 'string' } } },
      Req: {
        allOf: [
          ref('Base'),
          {
            oneOf: [
              { type: 'object', properties: { tenantId: { type: 'string' } }, required: ['tenantId'] },
              ref('Opt'),
            ],
          },
        ],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('is true when a sibling allOf base declares tenantId optional for every nested-union branch', () => {
    const schemas = {
      Base,
      Req: {
        allOf: [
          ref('Base'),
          {
            anyOf: [
              { type: 'object', properties: { other: { type: 'string' } } },
              { type: 'object', properties: { tenantId: { type: 'string' } } },
            ],
          },
        ],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
  });

  it('is true when every branch of a union nested in allOf keeps tenantId optional', () => {
    const schemas = {
      Base,
      Req: {
        allOf: [
          ref('Base'),
          {
            oneOf: [
              { type: 'object', properties: { tenantId: { type: 'string' } } },
              { type: 'object', properties: { tenantId: { type: 'string' } } },
            ],
          },
        ],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(true);
  });

  it('is true for an alias to a union whose variants all keep tenantId optional', () => {
    const schemas = {
      Base,
      ByKey: {
        type: 'object',
        allOf: [ref('Base')],
        properties: { processDefinitionKey: { type: 'string' } },
      },
      ById: {
        type: 'object',
        allOf: [ref('Base')],
        properties: { processDefinitionId: { type: 'string' } },
      },
      Instruction: { oneOf: [ref('ByKey'), ref('ById')] },
      Alias: { $ref: '#/components/schemas/Instruction' },
    };
    expect(optionalTenantIdInBody(schemas, 'Alias')).toBe(true);
  });

  it('is false for an alias to a union when a variant requires tenantId', () => {
    const schemas = {
      Base,
      Strict: { allOf: [ref('Base')], required: ['tenantId'] },
      Lenient: { allOf: [ref('Base')] },
      U: { oneOf: [ref('Strict'), ref('Lenient')] },
      Alias: { $ref: '#/components/schemas/U' },
    };
    expect(optionalTenantIdInBody(schemas, 'Alias')).toBe(false);
  });

  it('is false when a nested-union branch requires tenantId even with the union not last in allOf', () => {
    const schemas = {
      Base,
      // Named: a qualifying variant must have a component name (#54).
      Opt: { type: 'object', properties: { tenantId: { type: 'string' } } },
      Req: {
        allOf: [
          {
            oneOf: [
              { type: 'object', properties: { tenantId: { type: 'string' } }, required: ['tenantId'] },
              ref('Opt'),
            ],
          },
          ref('Base'),
        ],
      },
    };
    expect(optionalTenantIdInBody(schemas, 'Req')).toBe(false);
  });

  it('throws on an unresolved $ref inside a nested union branch', () => {
    const schemas = {
      Base,
      Req: {
        allOf: [
          ref('Base'),
          {
            oneOf: [
              { type: 'object', properties: { tenantId: { type: 'string' } } },
              { $ref: '#/components/schemas/Gone' },
            ],
          },
        ],
      },
    };
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(
      /#\/components\/schemas\/Gone/
    );
  });

  // Sibling unions are independent choices: summarising them must not
  // enumerate the Cartesian product (2^40 combinations here), yet must stay
  // exhaustive — every branch is still validated.
  // Named: a qualifying variant must have a component name (#54).
  const Plain = { type: 'object' };
  const manyUnions = (n: number, last: Record<string, unknown>) => ({
    allOf: [
      ref('Base'),
      ...Array.from({ length: n - 1 }, () => ({
        oneOf: [{ type: 'object' }, { type: 'object' }],
      })),
      { oneOf: [ref('Plain'), last] },
    ],
  });

  it('evaluates many sibling unions without combinatorial blow-up', () => {
    const start = Date.now();
    expect(optionalTenantIdInBody({ Base, Plain, Req: manyUnions(40, { type: 'object' }) }, 'Req')).toBe(true);
    // Generous bound: a safety net against exponential evaluation, not a timing assertion.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('is false when the last of many sibling unions has a branch requiring tenantId', () => {
    expect(
      optionalTenantIdInBody({ Base, Plain, Req: manyUnions(40, { required: ['tenantId'] }) }, 'Req')
    ).toBe(false);
  });

  it('throws on an unresolved $ref in the last of many sibling unions', () => {
    expect(() =>
      optionalTenantIdInBody({ Base, Plain, Req: manyUnions(40, ref('Gone')) }, 'Req')
    ).toThrow(/#\/components\/schemas\/Gone/);
  });

  it('throws when tenantId is declared only in a branch of each of two sibling unions', () => {
    const schemas = {
      A: { type: 'object', properties: { tenantId: {} } },
      B: { type: 'object', properties: { tenantId: {} } },
      Req: {
        allOf: [
          { oneOf: [ref('A'), { type: 'object' }] },
          { anyOf: [{ type: 'object' }, ref('B')] },
        ],
      },
    };
    // optionalTenantIdInBody alone would be false (combination (second, first)
    // never declares tenantId), but A and B each qualify under every
    // combination of the other union: no single flat variant list exists, so
    // extraction fails loudly (#54) rather than picking one.
    expect(() => optionalTenantIdInBody(schemas, 'Req')).toThrow(/multiple unions/);
  });
});
