import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test for the Camunda Hub public-API spec failure.
 *
 * The hub spec authors shared `parameters` and `responses` the conventional
 * OpenAPI way — via component refs (`#/components/parameters/FileKeyPathParam`,
 * `common-responses.yaml#/components/responses/Unauthorized`). But
 * `SwaggerParser.bundle()` strips the `components.parameters` /
 * `components.responses` sections entirely: it inlines the FIRST usage under
 * `paths`, then rewrites every OTHER usage to a path-local `$ref` such as
 *
 *   #/paths/~1files~1{fileKey}/get/parameters/0
 *   #/paths/~1info/get/responses/401
 *
 * Unlike schema refs (which Step-3 normalization always rewrites back to
 * `#/components/schemas/...` because that section survives), these have no
 * component section left to point at, so the path-local ref is the only form.
 *
 * Downstream consumers that only resolve `#/components/...` pointers (e.g. the
 * api-test-generator semantic-graph-extractor) cannot follow a `#/paths/...`
 * pointer and silently DROP the parameter/response — operations like
 * `PATCH /files/{fileKey}` then lose their path key parameter entirely.
 *
 * After bundling (without deref — that is how the downstream generators bundle),
 * no path-local parameter or response `$ref` may survive: each must be inlined
 * with a deep copy of its target. Scoped to the defect *class*: the assertion
 * checks every operation, not just one.
 */
describe('path-local parameter/response refs are inlined without deref', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-param-response-')
    );

    // common-responses.yaml — shared responses referenced by every operation.
    fs.writeFileSync(
      path.join(specDir, 'common-responses.yaml'),
      `openapi: '3.0.3'
info:
  title: Common Responses
  version: '1.0.0'
paths: {}
components:
  schemas:
    ProblemDetail:
      type: object
      properties:
        title:
          type: string
  responses:
    Unauthorized:
      description: The request lacks valid authentication credentials.
      content:
        application/problem+json:
          schema:
            $ref: '#/components/schemas/ProblemDetail'
`,
      'utf8'
    );

    // files.yaml — a shared path-parameter component reused across several
    // operations, plus a shared response. The GET defines the param inline (it
    // is the first usage SwaggerParser keeps); PATCH/DELETE reference it.
    fs.writeFileSync(
      path.join(specDir, 'files.yaml'),
      `openapi: '3.0.3'
info:
  title: Files
  version: '1.0.0'
paths:
  /files/{fileKey}:
    get:
      operationId: getFile
      parameters:
        - $ref: '#/components/parameters/FileKeyPathParam'
      responses:
        '200':
          description: OK
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
    patch:
      operationId: updateFile
      parameters:
        - $ref: '#/components/parameters/FileKeyPathParam'
      responses:
        '200':
          description: OK
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
    delete:
      operationId: deleteFile
      parameters:
        - $ref: '#/components/parameters/FileKeyPathParam'
      responses:
        '204':
          description: No Content
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
components:
  parameters:
    FileKeyPathParam:
      name: fileKey
      in: path
      required: true
      description: The unique key identifying the file.
      schema:
        type: string
`,
      'utf8'
    );

    // rest-api.yaml — entry point (must use YAML $ref syntax).
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /files/{fileKey}:
    $ref: 'files.yaml#/paths/~1files~1{fileKey}'
`,
      'utf8'
    );
  });

  it('inlines every path-local parameter and response ref (no deref)', async () => {
    // NOTE: deliberately NOT setting dereferencePathLocalRefs — this is how the
    // downstream api-test-generator / SDK bundling runs.
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;

    const survivors: string[] = [];
    function walk(node: unknown, jsonPath: string): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${jsonPath}[${i}]`));
        return;
      }
      const obj = node as Record<string, unknown>;
      // Scope to the defect class this test guards: path-local refs that
      // terminate at a `parameters/<idx>` or `responses/<status>` node. Other
      // path-local refs (e.g. surviving schema-position refs) are a separate
      // category covered elsewhere; flagging them here would make this test
      // fail for reasons unrelated to parameter/response inlining.
      if (typeof obj['$ref'] === 'string') {
        const ref = obj['$ref'] as string;
        if (
          ref.startsWith('#/paths/') &&
          (/\/parameters\/\d+$/.test(ref) || /\/responses\/[^/]+$/.test(ref))
        ) {
          survivors.push(`${jsonPath}: ${ref}`);
        }
      }
      for (const [key, val] of Object.entries(obj)) {
        walk(val, `${jsonPath}.${key}`);
      }
    }
    walk(spec['paths'], '#/paths');

    expect(
      survivors,
      `Path-local parameter/response $refs survived bundling:\n${survivors.join('\n')}`
    ).toHaveLength(0);
  });

  it('preserves the fileKey path parameter on every operation that shared it', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;
    const op = paths['/files/{fileKey}'];

    for (const method of ['get', 'patch', 'delete']) {
      const operation = op[method] as Record<string, unknown>;
      const params = operation['parameters'] as Array<Record<string, unknown>>;
      const fileKeyParam = params.find((p) => p['name'] === 'fileKey');
      expect(
        fileKeyParam,
        `${method.toUpperCase()} /files/{fileKey} must keep its fileKey path parameter`
      ).toBeDefined();
      expect(fileKeyParam?.['in']).toBe('path');
      expect(fileKeyParam?.['required']).toBe(true);
    }
  });
});
