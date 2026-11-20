import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../src/metadata.js';

/**
 * #54: `optionalTenantIdInBodyVariants` lists the request-body schemas that
 * carry an optional tenantId (per union variant, or the body itself), and
 * `optionalTenantIdsInBody` flags an optional `tenantIds` array.
 */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function op(schemas: Record<string, unknown>, body: Record<string, unknown>) {
  const spec = {
    openapi: '3.0.3',
    paths: {
      '/op': {
        post: {
          operationId: 'op',
          requestBody: { content: { 'application/json': { schema: body } } },
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: { schemas },
  };
  const found = extractMetadata(spec, schemas, 'sha256:test').operations.find(
    (o) => o.operationId === 'op'
  );
  if (!found) throw new Error('fixture operation not extracted');
  return found;
}

const ById = {
  type: 'object',
  required: ['processDefinitionId'],
  properties: { processDefinitionId: { type: 'string' }, tenantId: { type: 'string' } },
};
const ByKey = {
  type: 'object',
  required: ['processDefinitionKey'],
  properties: { processDefinitionKey: { type: 'string' } },
};

describe('optionalTenantIdInBodyVariants (#54)', () => {
  it('lists only the variants with an optional tenantId (suspendProcessDefinitions shape)', () => {
    const schemas = { ById, ByKey, Instr: { oneOf: [ref('ById'), ref('ByKey')] } };
    const o = op(schemas, ref('Instr'));
    expect(o.optionalTenantIdInBody).toBe(false);
    expect(o.optionalTenantIdInBodyVariants).toEqual(['ById']);
  });

  it('applies wrapper constraints to each variant', () => {
    const schemas = {
      ById,
      ByKey,
      Instr: {
        type: 'object',
        properties: { tenantId: { type: 'string' } },
        oneOf: [ref('ById'), ref('ByKey')],
      },
      Req: { required: ['tenantId'], oneOf: [ref('ById'), ref('ByKey')] },
    };
    expect(op(schemas, ref('Instr')).optionalTenantIdInBodyVariants).toEqual(['ById', 'ByKey']);
    expect(op(schemas, ref('Req')).optionalTenantIdInBodyVariants).toEqual([]);
  });

  it('lists the body schema itself for a non-union body', () => {
    expect(op({ ById }, ref('ById')).optionalTenantIdInBodyVariants).toEqual(['ById']);
    expect(op({ ByKey }, ref('ByKey')).optionalTenantIdInBodyVariants).toEqual([]);
  });

  it('throws when an inline variant carries an optional tenantId', () => {
    const schemas = { ByKey, Instr: { oneOf: [ref('ByKey'), ById] } };
    expect(() => op(schemas, ref('Instr'))).toThrow(/inline oneOf variant/);
  });

  it('throws when an inline body carries an optional tenantId', () => {
    expect(() => op({}, ById)).toThrow(/inline request body/);
  });
});

describe('optionalTenantIdInBodyVariants: decoding and indirect unions (#54)', () => {
  it('returns decoded component names for encoded body and variant refs', () => {
    const schemas = {
      'Org/ById': ById,
      'Base.Name': ById,
      ByKey,
      U: { oneOf: [{ $ref: '#/components/schemas/Org~1ById' }, ref('ByKey')] },
    };
    expect(op(schemas, ref('U')).optionalTenantIdInBodyVariants).toEqual(['Org/ById']);
    expect(
      op(schemas, { $ref: '#/components/schemas/Base%2EName' }).optionalTenantIdInBodyVariants
    ).toEqual(['Base.Name']);
  });

  it('discovers a union behind a component alias', () => {
    const schemas = { ById, ByKey, U: { oneOf: [ref('ById'), ref('ByKey')] }, Alias: ref('U') };
    expect(op(schemas, ref('Alias')).optionalTenantIdInBodyVariants).toEqual(['ById']);
  });

  it('discovers a union inside allOf and keeps enclosing constraints', () => {
    const schemas = {
      ById,
      ByKey,
      U: { oneOf: [ref('ById'), ref('ByKey')] },
      Comp: { allOf: [ref('U'), { type: 'object' }] },
      CompReq: { allOf: [ref('U'), { required: ['tenantId'] }] },
    };
    expect(op(schemas, ref('Comp')).optionalTenantIdInBodyVariants).toEqual(['ById']);
    expect(op(schemas, ref('CompReq')).optionalTenantIdInBodyVariants).toEqual([]);
  });

  it('lists the body itself when every branch of an indirect union qualifies', () => {
    const schemas = { ById, U: { oneOf: [ref('ById')] }, Alias: ref('U') };
    expect(op(schemas, ref('Alias')).optionalTenantIdInBodyVariants).toEqual(['Alias']);
  });

  it('throws when several unions each have a qualifying variant', () => {
    const schemas = {
      ById,
      ByKey,
      U: { oneOf: [ref('ById'), ref('ByKey')] },
      V: { anyOf: [ref('ById'), ref('ByKey')] },
      Both: { allOf: [ref('U'), ref('V')] },
    };
    expect(() => op(schemas, ref('Both'))).toThrow(/multiple unions/);
  });
});

describe('optionalTenantIdsInBody (#54)', () => {
  it('is true for an optional tenantIds array (activateJobs shape)', () => {
    const schemas = {
      Act: { type: 'object', properties: { tenantIds: { type: 'array', items: { type: 'string' } } } },
    };
    const o = op(schemas, ref('Act'));
    expect(o.optionalTenantIdsInBody).toBe(true);
    expect(o.optionalTenantIdInBody).toBe(false);
  });

  it('is false when tenantIds is required or absent', () => {
    const schemas = {
      Req: { type: 'object', required: ['tenantIds'], properties: { tenantIds: { type: 'array' } } },
      None: { type: 'object', properties: {} },
    };
    expect(op(schemas, ref('Req')).optionalTenantIdsInBody).toBe(false);
    expect(op(schemas, ref('None')).optionalTenantIdsInBody).toBe(false);
  });
});
