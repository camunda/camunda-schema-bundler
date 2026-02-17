import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test: structurally identical component schemas must NOT be
 * collapsed during dedup. Each named component schema is semantically
 * distinct even when its structure matches another.
 *
 * Real-world example: CancelProcessInstanceRequest and
 * DeleteProcessInstanceRequest both have `{ operationReference: ... }`
 * but must remain separate types so the cancel endpoint uses
 * CancelProcessInstanceRequest, not DeleteProcessInstanceRequest.
 */
describe('ambiguous signature dedup', () => {
  let specDir: string;

  beforeAll(() => {
    // Create a minimal multi-file spec where two component schemas share
    // the same structure, and two endpoints each reference one of them.
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-dedup-test-'));

    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/things/{id}/cancellation': {
          post: {
            operationId: 'cancelThing',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CancelThingRequest' },
                },
              },
            },
            responses: { '204': { description: 'Cancelled' } },
          },
        },
        '/things/{id}': {
          delete: {
            operationId: 'deleteThing',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DeleteThingRequest' },
                },
              },
            },
            responses: { '204': { description: 'Deleted' } },
          },
        },
      },
      components: {
        schemas: {
          CancelThingRequest: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              operationReference: { type: 'integer', format: 'int64' },
            },
          },
          DeleteThingRequest: {
            type: 'object',
            nullable: true,
            additionalProperties: false,
            properties: {
              operationReference: { type: 'integer', format: 'int64' },
            },
          },
        },
      },
    };

    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      JSON.stringify(spec, null, 2),
      'utf8'
    );
  });

  it('preserves distinct $refs for structurally identical component schemas', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as {
      paths: Record<string, Record<string, { requestBody?: { content?: { 'application/json'?: { schema?: { $ref?: string } } } } }>>;
      components: { schemas: Record<string, unknown> };
    };

    // Both schemas must still exist as separate component schemas
    expect(spec.components.schemas['CancelThingRequest']).toBeDefined();
    expect(spec.components.schemas['DeleteThingRequest']).toBeDefined();

    // The cancel endpoint must reference CancelThingRequest, not DeleteThingRequest
    const cancelRef =
      spec.paths['/things/{id}/cancellation']?.post?.requestBody?.content?.[
        'application/json'
      ]?.schema?.$ref;
    expect(cancelRef).toBe('#/components/schemas/CancelThingRequest');

    // The delete endpoint must reference DeleteThingRequest
    const deleteRef =
      spec.paths['/things/{id}']?.delete?.requestBody?.content?.[
        'application/json'
      ]?.schema?.$ref;
    expect(deleteRef).toBe('#/components/schemas/DeleteThingRequest');
  });

  it('still deduplicates inline schemas with a unique component match', async () => {
    // Create a spec with an inline schema that matches exactly one component
    const inlineSpecDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-dedup-inline-')
    );

    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': {
                  // Inline schema identical to ItemRequest component
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      value: { type: 'integer' },
                    },
                    required: ['name'],
                  },
                },
              },
            },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
      components: {
        schemas: {
          // Only ONE component matches this structure (no ambiguity)
          ItemRequest: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'integer' },
            },
            required: ['name'],
          },
        },
      },
    };

    fs.writeFileSync(
      path.join(inlineSpecDir, 'rest-api.yaml'),
      JSON.stringify(spec, null, 2),
      'utf8'
    );

    const result = await bundle({ specDir: inlineSpecDir });
    const bundledSpec = result.spec as {
      paths: Record<string, Record<string, { requestBody?: { content?: { 'application/json'?: { schema?: { $ref?: string } } } } }>>;
    };

    // The inline schema should have been replaced with a $ref to ItemRequest
    const ref =
      bundledSpec.paths['/items']?.post?.requestBody?.content?.[
        'application/json'
      ]?.schema?.$ref;
    expect(ref).toBe('#/components/schemas/ItemRequest');
  });
});
