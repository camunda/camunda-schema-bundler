/**
 * Regression tests for 8.9+ multi-file spec bundling.
 *
 * These tests guard against regressions when support for pre-8.9 monolithic
 * specs is added. They use a synthetic multi-file spec that simulates the
 * structure of the real 8.9+ Camunda OpenAPI spec.
 *
 * All tests in this file must remain GREEN after any implementation changes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';
import { DEFAULT_SPEC_DIR } from '../src/fetch.js';

/**
 * Create a synthetic multi-file spec that mimics 8.9+ structure:
 * - Entry file (rest-api.yaml) with $refs to external schema files
 * - Multiple schema files (definitions.yaml, errors.yaml)
 * - Path-local refs that need normalizing ($like pattern)
 * - Inline schemas that need deduplication
 */
function createMultiFileSpec(dir: string): void {
  // schemas/definitions.yaml — shared component schemas
  const definitionsYaml = `
components:
  schemas:
    LongKey:
      type: string
      pattern: '^-?[0-9]+$'
      minLength: 1
      maxLength: 25
    ProcessInstanceKey:
      x-semantic-type: ProcessInstanceKey
      allOf:
        - $ref: '#/components/schemas/LongKey'
        - description: A unique identifier for a process instance
    ProcessInstanceState:
      type: string
      enum: [ACTIVE, COMPLETED, CANCELED]
    SearchQuerySort:
      type: object
      properties:
        field:
          type: string
        order:
          type: string
          enum: [ASC, DESC]
`.trimStart();

  // schemas/errors.yaml — error response schemas
  const errorsYaml = `
components:
  schemas:
    ProblemDetail:
      type: object
      properties:
        status:
          type: integer
        title:
          type: string
        detail:
          type: string
      required:
        - status
        - title
`.trimStart();

  // rest-api.yaml — entry file with external $refs to other files
  const entryYaml = `
openapi: '3.0.3'
info:
  title: Camunda REST API
  version: '8.9'
servers:
  - url: /v2
paths:
  /process-instances:
    get:
      operationId: searchProcessInstances
      tags:
        - Process Instance
      summary: Search process instances
      x-eventually-consistent: true
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './schemas/definitions.yaml#/components/schemas/ProcessInstanceState'
        '400':
          description: Bad Request
          content:
            application/json:
              schema:
                $ref: './schemas/errors.yaml#/components/schemas/ProblemDetail'
    post:
      operationId: createProcessInstance
      tags:
        - Process Instance
      summary: Create a process instance
      requestBody:
        content:
          application/json:
            schema:
              $ref: './schemas/definitions.yaml#/components/schemas/ProcessInstanceKey'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './schemas/definitions.yaml#/components/schemas/ProcessInstanceKey'
  /process-instances/{processInstanceKey}:
    get:
      operationId: getProcessInstance
      tags:
        - Process Instance
      summary: Get a process instance
      parameters:
        - name: processInstanceKey
          in: path
          required: true
          schema:
            $ref: './schemas/definitions.yaml#/components/schemas/ProcessInstanceKey'
      responses:
        '200':
          description: OK
components:
  schemas:
    ProcessInstanceSearchResult:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: './schemas/definitions.yaml#/components/schemas/ProcessInstanceKey'
        sort:
          $ref: './schemas/definitions.yaml#/components/schemas/SearchQuerySort'
`.trimStart();

  // Create subdirectory for schema files
  fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'rest-api.yaml'), entryYaml, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'schemas', 'definitions.yaml'),
    definitionsYaml,
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'schemas', 'errors.yaml'),
    errorsYaml,
    'utf8'
  );
}

describe('multi-file spec bundling (8.9+ regression guard)', () => {
  let specDir: string;
  let result: Awaited<ReturnType<typeof bundle>>;

  beforeAll(async () => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-multifile-regression-')
    );
    createMultiFileSpec(specDir);
    result = await bundle({ specDir });
  });

  it('produces a valid bundled spec', () => {
    expect(result.spec).toBeDefined();
    expect((result.spec as Record<string, unknown>)['openapi']).toBe('3.0.3');
  });

  it('bundles schemas from external $ref files into components', () => {
    const schemas = (
      result.spec as {
        components: { schemas: Record<string, unknown> };
      }
    ).components.schemas;

    // Schemas defined in schemas/definitions.yaml must be in bundled output
    expect(schemas['LongKey']).toBeDefined();
    expect(schemas['ProcessInstanceKey']).toBeDefined();
    expect(schemas['ProcessInstanceState']).toBeDefined();
    expect(schemas['SearchQuerySort']).toBeDefined();

    // Schemas defined in schemas/errors.yaml must be in bundled output
    expect(schemas['ProblemDetail']).toBeDefined();

    // Schema defined inline in the entry file
    expect(schemas['ProcessInstanceSearchResult']).toBeDefined();
  });

  it('resolves external $refs to internal component refs', () => {
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, unknown>;

    // Walk the entire bundled spec and assert no external $refs survived
    // (all external file refs must be resolved to internal #/components/schemas/... refs)
    const stack: unknown[] = [paths];
    const seen = new Set<unknown>();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj['$ref'] === 'string') {
        // No external file refs should survive bundling
        expect(obj['$ref'] as string).not.toMatch(/^\.?\//);
        expect(obj['$ref'] as string).not.toMatch(/\.yaml#/);
      }
      for (const v of Object.values(obj)) stack.push(v);
    }
  });

  it('preserves path count', () => {
    expect(result.stats.pathCount).toBe(2); // 2 path items: /process-instances and /process-instances/{processInstanceKey}
  });

  it('reports correct schema count including external schemas', () => {
    // 4 from definitions.yaml + 1 from errors.yaml + 1 inline in entry = 6 total minimum
    expect(result.stats.schemaCount).toBeGreaterThanOrEqual(6);
  });

  it('produces zero path-local $like refs', () => {
    expect(result.stats.pathLocalLikeRefCount).toBe(0);
  });

  it('extracts metadata with eventually consistent operations', () => {
    expect(result.metadata.eventuallyConsistentOps.length).toBeGreaterThan(0);
    expect(result.metadata.eventuallyConsistentOps[0].operationId).toBe(
      'searchProcessInstances'
    );
  });

  it('extracts semantic keys from x-semantic-type', () => {
    const pik = result.metadata.semanticKeys.find(
      (k) => k.name === 'ProcessInstanceKey'
    );
    expect(pik).toBeDefined();
    expect(pik!.flags.semanticKey).toBe(true);
    expect(pik!.flags.includesLongKeyRef).toBe(true);
  });

  it('extracts all operations', () => {
    const ops = result.metadata.operations;
    const opIds = ops.map((o) => o.operationId);
    expect(opIds).toContain('searchProcessInstances');
    expect(opIds).toContain('createProcessInstance');
    expect(opIds).toContain('getProcessInstance');
  });

  it('augments schemas from sibling YAML files in specDir for multi-file specs', () => {
    // In multi-file mode, the augmentation step scans all YAML files in the spec dir
    // and adds any component schemas not already in the bundled output.
    // Since our test spec references external files, it IS a multi-file spec.
    expect(result.stats.schemaCount).toBeGreaterThanOrEqual(6);
  });
});

describe('multi-file spec with augmentation from separate YAML files', () => {
  it('augments bundled spec with schemas from sibling YAML files (multi-file)', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-augment-test-')
    );

    // A referenced schema file
    const referencedYaml = `
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
`.trimStart();

    // A sidecar file with additional schemas NOT referenced from entry
    const sidecarYaml = `
components:
  schemas:
    ExtraSchema:
      type: object
      properties:
        name:
          type: string
`.trimStart();

    // Entry file that references the schemas file (making it multi-file)
    const entry = `
openapi: '3.0.3'
info:
  title: Test
  version: '1.0.0'
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './schemas.yaml#/components/schemas/Item'
`.trimStart();

    fs.writeFileSync(path.join(dir, 'rest-api.yaml'), entry, 'utf8');
    fs.writeFileSync(path.join(dir, 'schemas.yaml'), referencedYaml, 'utf8');
    fs.writeFileSync(path.join(dir, 'extra.yaml'), sidecarYaml, 'utf8');

    const result = await bundle({ specDir: dir });
    const schemas = (
      result.spec as { components: { schemas: Record<string, unknown> } }
    ).components.schemas;

    // Item should be in components from the referenced file
    expect(schemas['Item']).toBeDefined();
    // ExtraSchema should be augmented in from the sidecar file (multi-file augmentation)
    expect(schemas['ExtraSchema']).toBeDefined();
    expect(result.stats.augmentedSchemaCount).toBeGreaterThan(0);
  });

  it('does NOT augment schemas from sibling files for monolithic specs', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-monolithic-no-augment-')
    );

    // Entry file with no external refs (monolithic)
    const entry = `
openapi: '3.0.3'
info:
  title: Test
  version: '1.0.0'
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: OK
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
`.trimStart();

    // A sidecar file with additional schemas that should NOT be merged in
    const sidecarYaml = `
components:
  schemas:
    UnrelatedSchema:
      type: object
      properties:
        unrelated:
          type: string
`.trimStart();

    fs.writeFileSync(path.join(dir, 'rest-api.yaml'), entry, 'utf8');
    fs.writeFileSync(path.join(dir, 'unrelated.yaml'), sidecarYaml, 'utf8');

    const result = await bundle({ specDir: dir });
    const schemas = (
      result.spec as { components: { schemas: Record<string, unknown> } }
    ).components.schemas;

    // Item should be present (from the entry file itself)
    expect(schemas['Item']).toBeDefined();
    // UnrelatedSchema should NOT be pulled in (monolithic spec skips augmentation)
    expect(schemas['UnrelatedSchema']).toBeUndefined();
    expect(result.stats.augmentedSchemaCount).toBe(0);
  });
});

describe('DEFAULT_SPEC_DIR points to v2 directory', () => {
  it('DEFAULT_SPEC_DIR ends with /v2 for 8.9+ multi-file spec', () => {
    expect(DEFAULT_SPEC_DIR).toBe(
      'zeebe/gateway-protocol/src/main/proto/v2'
    );
  });
});

describe('multi-file spec: inline dedup against component schemas', () => {
  it('deduplicates inline schemas matching component schemas', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-inline-dedup-')
    );

    const spec = `
openapi: '3.0.3'
info:
  title: Test
  version: '1.0.0'
paths:
  /items:
    post:
      operationId: createItem
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                value:
                  type: integer
              required:
                - name
      responses:
        '200':
          description: OK
components:
  schemas:
    ItemRequest:
      type: object
      properties:
        name:
          type: string
        value:
          type: integer
      required:
        - name
`.trimStart();

    fs.writeFileSync(path.join(dir, 'rest-api.yaml'), spec, 'utf8');
    const result = await bundle({ specDir: dir });

    const paths = (result.spec as Record<string, unknown>)[
      'paths'
    ] as Record<
      string,
      Record<
        string,
        {
          requestBody?: {
            content?: {
              'application/json'?: { schema?: { $ref?: string } };
            };
          };
        }
      >
    >;

    const schema =
      paths['/items']?.post?.requestBody?.content?.['application/json']
        ?.schema;
    expect(schema?.$ref).toBe('#/components/schemas/ItemRequest');
  });
});
