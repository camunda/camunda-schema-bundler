import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../src/metadata.js';

describe('extractMetadata', () => {
  const schemas: Record<string, unknown> = {
    LongKey: {
      type: 'string',
      pattern: '^-?[0-9]+$',
      minLength: 1,
      maxLength: 25,
    },
    ProcessInstanceKey: {
      'x-semantic-type': 'ProcessInstanceKey',
      allOf: [
        { $ref: '#/components/schemas/LongKey' },
        { description: 'A process instance key' },
      ],
    },
    ResourceKey: {
      oneOf: [
        { $ref: '#/components/schemas/ProcessInstanceKey' },
        { $ref: '#/components/schemas/LongKey' },
      ],
    },
    BatchKey: {
      anyOf: [
        { $ref: '#/components/schemas/ProcessInstanceKey' },
        { type: 'string', format: 'uuid' },
      ],
    },
    Tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
    },
    PlainSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    TenantBody: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tenantId: { type: 'string' },
      },
      required: ['name'],
    },
  };

  const spec: Record<string, unknown> = {
    components: { schemas },
    paths: {
      '/process-instances': {
        get: {
          operationId: 'listProcessInstances',
          tags: ['Process Instance'],
          summary: 'List process instances',
          description: 'Returns a list of process instances',
          'x-eventually-consistent': true,
          parameters: [
            { in: 'query', name: 'limit', required: false },
            { in: 'query', name: 'sort', required: false },
          ],
        },
        post: {
          operationId: 'createProcessInstance',
          tags: ['Process Instance'],
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TenantBody' },
              },
            },
          },
        },
      },
      '/process-instances/{processInstanceKey}': {
        get: {
          operationId: 'getProcessInstance',
          tags: ['Process Instance'],
          parameters: [
            { in: 'path', name: 'processInstanceKey', required: true },
          ],
        },
      },
      '/jobs': {
        post: {
          operationId: 'activateJobs',
          tags: ['Job'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/PlainSchema' },
                    { $ref: '#/components/schemas/Tags' },
                  ],
                },
              },
            },
          },
        },
      },
    },
  };

  const metadata = extractMetadata(spec, schemas, 'sha256:test');

  it('extracts semantic keys from x-semantic-type schemas', () => {
    expect(metadata.semanticKeys).toHaveLength(1);
    const key = metadata.semanticKeys[0];
    expect(key.name).toBe('ProcessInstanceKey');
    expect(key.semanticType).toBe('ProcessInstanceKey');
    expect(key.flags.semanticKey).toBe(true);
    expect(key.flags.includesLongKeyRef).toBe(true);
    expect(key.composition.schemaKind).toBe('allOf');
    expect(key.composition.refs).toEqual(['LongKey']);
  });

  it('inherits LongKey constraints for pure ref aliases', () => {
    const key = metadata.semanticKeys[0];
    expect(key.constraints.pattern).toBe('^-?[0-9]+$');
    expect(key.constraints.minLength).toBe(1);
    expect(key.constraints.maxLength).toBe(25);
  });

  it('extracts union types', () => {
    expect(metadata.unions).toHaveLength(2);
    const wrapper = metadata.unions.find((u) => u.name === 'ResourceKey');
    expect(wrapper).toBeDefined();
    expect(wrapper!.kind).toBe('union-wrapper');
    expect(wrapper!.branches).toHaveLength(2);
    expect(wrapper!.branches[0].branchType).toBe('ref');
    expect(wrapper!.branches[0].ref).toBe('ProcessInstanceKey');
  });

  it('classifies hybrid unions', () => {
    const hybrid = metadata.unions.find((u) => u.name === 'BatchKey');
    expect(hybrid).toBeDefined();
    expect(hybrid!.kind).toBe('hybrid-union');
    expect(hybrid!.branches).toHaveLength(2);
    expect(hybrid!.branches[1].branchType).toBe('uuid');
  });

  it('extracts array schemas', () => {
    expect(metadata.arrays).toHaveLength(1);
    expect(metadata.arrays[0].name).toBe('Tags');
    expect(metadata.arrays[0].minItems).toBe(1);
    expect(metadata.arrays[0].maxItems).toBe(10);
  });

  it('detects eventually consistent operations', () => {
    expect(metadata.eventuallyConsistentOps).toHaveLength(1);
    expect(metadata.eventuallyConsistentOps[0].operationId).toBe(
      'listProcessInstances'
    );
  });

  it('extracts all operations', () => {
    expect(metadata.operations).toHaveLength(4);
    const create = metadata.operations.find(
      (o) => o.operationId === 'createProcessInstance'
    );
    expect(create).toBeDefined();
    expect(create!.hasRequestBody).toBe(true);
    expect(create!.requestBodyUnion).toBe(false);
  });

  it('detects union request bodies', () => {
    const activate = metadata.operations.find(
      (o) => o.operationId === 'activateJobs'
    );
    expect(activate).toBeDefined();
    expect(activate!.requestBodyUnion).toBe(true);
  });

  it('reports correct integrity counts', () => {
    expect(metadata.integrity.totalSemanticKeys).toBe(1);
    expect(metadata.integrity.totalUnions).toBe(2);
    expect(metadata.integrity.totalOperations).toBe(4);
    expect(metadata.integrity.totalEventuallyConsistent).toBe(1);
  });

  it('extracts operation description', () => {
    const list = metadata.operations.find(
      (o) => o.operationId === 'listProcessInstances'
    );
    expect(list!.description).toBe('Returns a list of process instances');
  });

  it('extracts path parameters', () => {
    const get = metadata.operations.find(
      (o) => o.operationId === 'getProcessInstance'
    );
    expect(get).toBeDefined();
    expect(get!.pathParams).toEqual(['processInstanceKey']);
    expect(get!.bodyOnly).toBe(false);
  });

  it('extracts query parameters with required flag', () => {
    const list = metadata.operations.find(
      (o) => o.operationId === 'listProcessInstances'
    );
    expect(list!.queryParams).toEqual([
      { name: 'limit', required: false },
      { name: 'sort', required: false },
    ]);
    expect(list!.bodyOnly).toBe(false);
  });

  it('computes bodyOnly for body-only operations', () => {
    const create = metadata.operations.find(
      (o) => o.operationId === 'createProcessInstance'
    );
    expect(create!.bodyOnly).toBe(true);
    expect(create!.pathParams).toEqual([]);
    expect(create!.queryParams).toEqual([]);
  });

  it('extracts requestBodyUnionRefs', () => {
    const activate = metadata.operations.find(
      (o) => o.operationId === 'activateJobs'
    );
    expect(activate!.requestBodyUnionRefs).toEqual(['PlainSchema', 'Tags']);
  });

  it('detects optionalTenantIdInBody', () => {
    const create = metadata.operations.find(
      (o) => o.operationId === 'createProcessInstance'
    );
    expect(create!.optionalTenantIdInBody).toBe(true);

    // activateJobs has union body - PlainSchema has no tenantId
    const activate = metadata.operations.find(
      (o) => o.operationId === 'activateJobs'
    );
    expect(activate!.optionalTenantIdInBody).toBe(false);
  });
});
