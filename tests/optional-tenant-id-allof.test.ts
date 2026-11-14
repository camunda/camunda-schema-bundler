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
});
