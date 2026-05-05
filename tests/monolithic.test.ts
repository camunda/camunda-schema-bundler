/**
 * Tests for pre-8.9 monolithic spec support.
 *
 * Covers:
 * - specDirForRef(): correct directory selection based on git ref
 * - bundle(): monolithic spec handling (no augmentation from sibling files)
 * - bundle(): full pipeline works on a synthetic pre-8.9 monolithic spec
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';
import {
  specDirForRef,
  DEFAULT_SPEC_DIR,
  MONOLITHIC_SPEC_DIR,
} from '../src/fetch.js';

// ── specDirForRef() ────────────────────────────────────────────────────────

describe('specDirForRef()', () => {
  it('returns v2 dir for "main"', () => {
    expect(specDirForRef('main')).toBe(DEFAULT_SPEC_DIR);
  });

  it('returns v2 dir for stable/8.9', () => {
    expect(specDirForRef('stable/8.9')).toBe(DEFAULT_SPEC_DIR);
  });

  it('returns v2 dir for stable/8.10', () => {
    expect(specDirForRef('stable/8.10')).toBe(DEFAULT_SPEC_DIR);
  });

  it('returns v2 dir for stable/8.11', () => {
    expect(specDirForRef('stable/8.11')).toBe(DEFAULT_SPEC_DIR);
  });

  it('returns monolithic dir for stable/8.8', () => {
    expect(specDirForRef('stable/8.8')).toBe(MONOLITHIC_SPEC_DIR);
  });

  it('returns monolithic dir for stable/8.7', () => {
    expect(specDirForRef('stable/8.7')).toBe(MONOLITHIC_SPEC_DIR);
  });

  it('returns monolithic dir for stable/8.6', () => {
    expect(specDirForRef('stable/8.6')).toBe(MONOLITHIC_SPEC_DIR);
  });

  it('returns monolithic dir for stable/8.5', () => {
    expect(specDirForRef('stable/8.5')).toBe(MONOLITHIC_SPEC_DIR);
  });

  it('returns v2 dir for unrecognized refs (SHA, tag)', () => {
    expect(specDirForRef('abc1234')).toBe(DEFAULT_SPEC_DIR);
    expect(specDirForRef('v8.8.0')).toBe(DEFAULT_SPEC_DIR);
  });

  it('MONOLITHIC_SPEC_DIR does not end with /v2', () => {
    expect(MONOLITHIC_SPEC_DIR).not.toMatch(/\/v2$/);
  });

  it('DEFAULT_SPEC_DIR ends with /v2', () => {
    expect(DEFAULT_SPEC_DIR).toMatch(/\/v2$/);
  });
});

// ── Monolithic spec bundling ───────────────────────────────────────────────

/**
 * Synthetic pre-8.9 style monolithic spec (~8.8):
 * - Single YAML file with all paths, schemas, components inline
 * - No external $refs to other files
 * - Uses /v1 server URL
 */
function createMonolithicSpec(filePath: string): void {
  const yaml = `
openapi: '3.0.3'
info:
  title: Camunda REST API
  version: '8.8'
servers:
  - url: /v1
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
                $ref: '#/components/schemas/ProcessInstanceSearchResult'
        '400':
          description: Bad Request
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProblemDetail'
    post:
      operationId: createProcessInstance
      tags:
        - Process Instance
      summary: Create a process instance
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateProcessInstanceRequest'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CreateProcessInstanceResponse'
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
            $ref: '#/components/schemas/ProcessInstanceKey'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProcessInstance'
    delete:
      operationId: cancelProcessInstance
      tags:
        - Process Instance
      summary: Cancel a process instance
      parameters:
        - name: processInstanceKey
          in: path
          required: true
          schema:
            $ref: '#/components/schemas/ProcessInstanceKey'
      responses:
        '204':
          description: No Content
  /jobs/activation:
    post:
      operationId: activateJobs
      tags:
        - Job
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ActivateJobsRequest'
      responses:
        '200':
          description: OK
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
        - description: A unique key for a process instance
    ProcessInstanceState:
      type: string
      enum:
        - ACTIVE
        - COMPLETED
        - CANCELED
        - TERMINATED
    ProcessInstance:
      type: object
      properties:
        processInstanceKey:
          $ref: '#/components/schemas/ProcessInstanceKey'
        processDefinitionId:
          type: string
        state:
          $ref: '#/components/schemas/ProcessInstanceState'
      required:
        - processInstanceKey
        - processDefinitionId
    ProcessInstanceSearchResult:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/ProcessInstance'
        page:
          type: object
          properties:
            totalItems:
              type: integer
    CreateProcessInstanceRequest:
      type: object
      properties:
        processDefinitionId:
          type: string
        variables:
          type: object
          additionalProperties: true
      required:
        - processDefinitionId
    CreateProcessInstanceResponse:
      type: object
      x-semantic-provider:
        - processInstanceKey
      properties:
        processInstanceKey:
          $ref: '#/components/schemas/ProcessInstanceKey'
        processDefinitionId:
          type: string
    ActivateJobsRequest:
      type: object
      properties:
        type:
          type: string
        maxJobsToActivate:
          type: integer
      required:
        - type
        - maxJobsToActivate
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

  fs.writeFileSync(filePath, yaml, 'utf8');
}

describe('monolithic spec bundling (pre-8.9 simulation)', () => {
  let specDir: string;
  let result: Awaited<ReturnType<typeof bundle>>;

  beforeAll(async () => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-monolithic-spec-')
    );
    createMonolithicSpec(path.join(specDir, 'rest-api.yaml'));
    result = await bundle({ specDir });
  });

  it('produces a valid bundled spec', () => {
    expect(result.spec).toBeDefined();
    expect((result.spec as Record<string, unknown>)['openapi']).toBe('3.0.3');
  });

  it('contains all inline schemas from the monolithic file', () => {
    const schemas = (
      result.spec as {
        components: { schemas: Record<string, unknown> };
      }
    ).components.schemas;

    expect(schemas['LongKey']).toBeDefined();
    expect(schemas['ProcessInstanceKey']).toBeDefined();
    expect(schemas['ProcessInstanceState']).toBeDefined();
    expect(schemas['ProcessInstance']).toBeDefined();
    expect(schemas['ProcessInstanceSearchResult']).toBeDefined();
    expect(schemas['CreateProcessInstanceRequest']).toBeDefined();
    expect(schemas['CreateProcessInstanceResponse']).toBeDefined();
    expect(schemas['ActivateJobsRequest']).toBeDefined();
    expect(schemas['ProblemDetail']).toBeDefined();
  });

  it('preserves correct path count', () => {
    expect(result.stats.pathCount).toBe(3);
  });

  it('reports zero augmented schemas (no sibling files)', () => {
    // Monolithic spec should not augment from sibling files
    expect(result.stats.augmentedSchemaCount).toBe(0);
  });

  it('produces zero path-local $like refs', () => {
    expect(result.stats.pathLocalLikeRefCount).toBe(0);
  });

  it('extracts metadata with eventually consistent operations', () => {
    const consistentOps = result.metadata.eventuallyConsistentOps;
    expect(consistentOps.length).toBeGreaterThan(0);
    expect(consistentOps[0].operationId).toBe('searchProcessInstances');
  });

  it('extracts semantic keys', () => {
    const pik = result.metadata.semanticKeys.find(
      (k) => k.name === 'ProcessInstanceKey'
    );
    expect(pik).toBeDefined();
    expect(pik!.flags.semanticKey).toBe(true);
    expect(pik!.flags.includesLongKeyRef).toBe(true);
  });

  it('extracts all operations', () => {
    const opIds = result.metadata.operations.map((o) => o.operationId);
    expect(opIds).toContain('searchProcessInstances');
    expect(opIds).toContain('createProcessInstance');
    expect(opIds).toContain('getProcessInstance');
    expect(opIds).toContain('cancelProcessInstance');
    expect(opIds).toContain('activateJobs');
  });

  it('extracts semantic providers', () => {
    const provider = result.metadata.semanticProviders.find(
      (p) => p.schemaName === 'CreateProcessInstanceResponse'
    );
    expect(provider).toBeDefined();
    expect(provider!.providers).toContain('processInstanceKey');
  });

  it('builds endpoint map with one entry per method per path', () => {
    expect(result.endpointMap).toBeDefined();
    // /process-instances has get+post, /{key} has get+delete, /jobs/activation has post = 5
    expect(Object.keys(result.endpointMap).length).toBe(5);

    const ops = Object.keys(result.endpointMap);
    expect(ops).toContain('GET /process-instances');
    expect(ops).toContain('POST /process-instances');
    expect(ops).toContain('GET /process-instances/{processInstanceKey}');
    expect(ops).toContain('DELETE /process-instances/{processInstanceKey}');
    expect(ops).toContain('POST /jobs/activation');
  });

  it('endpoint map source files point to entry file for monolithic specs', () => {
    for (const entry of Object.values(result.endpointMap)) {
      expect(entry.file).toBe('rest-api.yaml');
    }
  });

  it('endpoint map entries carry the operationId from the bundled spec', () => {
    expect(result.endpointMap['POST /process-instances'].operationId).toBe(
      'createProcessInstance'
    );
    expect(
      result.endpointMap['GET /process-instances/{processInstanceKey}']
        .operationId
    ).toBe('getProcessInstance');
    expect(
      result.endpointMap['DELETE /process-instances/{processInstanceKey}']
        .operationId
    ).toBe('cancelProcessInstance');
    expect(result.endpointMap['POST /jobs/activation'].operationId).toBe(
      'activateJobs'
    );
  });
});

describe('monolithic spec: sibling unrelated YAML files are not merged in', () => {
  it('does not pull in schemas from unrelated sibling YAML files', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-monolithic-sibling-')
    );

    // Main monolithic spec (no external refs)
    const mainSpec = `
openapi: '3.0.3'
info:
  title: Main API
  version: '8.8'
paths:
  /things:
    get:
      operationId: listThings
      responses:
        '200':
          description: OK
components:
  schemas:
    Thing:
      type: object
      properties:
        id:
          type: string
`.trimStart();

    // Unrelated v1 spec (simulates rest-api-v1.yaml on pre-8.9 branches)
    const v1Spec = `
openapi: '3.0.3'
info:
  title: Old v1 API
  version: '1.0.0'
paths: {}
components:
  schemas:
    V1OnlySchema:
      type: object
      properties:
        legacyField:
          type: string
`.trimStart();

    fs.writeFileSync(path.join(dir, 'rest-api.yaml'), mainSpec, 'utf8');
    fs.writeFileSync(path.join(dir, 'rest-api-v1.yaml'), v1Spec, 'utf8');

    const result = await bundle({ specDir: dir });
    const schemas = (
      result.spec as { components: { schemas: Record<string, unknown> } }
    ).components.schemas;

    // Main spec schema should be present
    expect(schemas['Thing']).toBeDefined();
    // V1OnlySchema must NOT be pulled in from the unrelated file
    expect(schemas['V1OnlySchema']).toBeUndefined();
    expect(result.stats.augmentedSchemaCount).toBe(0);
  });
});
