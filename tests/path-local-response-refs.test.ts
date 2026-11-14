import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test for path-local `$ref`s surviving as values of `responses`
 * maps.
 *
 * `SwaggerParser.bundle()` drops `components.responses` entirely (the section
 * does not survive bundling), inlines the first usage of each shared response,
 * then rewrites every other usage into a path-local `$ref`:
 *
 *   GET /agent-definitions/{agentDefinitionKey}:
 *     responses:
 *       '401': { $ref: '#/paths/~1clock/get/responses/401' }
 *
 * Step-3 signature normalization cannot rescue these: it only rewrites to
 * `#/components/schemas/*`, and there is no surviving component to point at.
 * The real Camunda spec produced 852 of them. Consumers that only resolve
 * `#/components/...` pointers (e.g. api-test-generator) silently drop the
 * response.
 *
 * Response objects are never emitted as named types by any generator (their
 * schemas are, and those keep their `#/components/schemas/*` refs), so inlining
 * is lossless — the same reasoning as the parameter pass.
 *
 * The assertion is deliberately class-scoped: no path-local `$ref` may survive
 * as the value of ANY `responses` map entry, not just the one this fixture
 * reproduces.
 */

/** Every `responses` map entry in the spec, with a human-readable location. */
function collectResponseEntries(
  spec: Record<string, unknown>
): { where: string; response: Record<string, unknown> }[] {
  const found: { where: string; response: Record<string, unknown> }[] = [];
  const paths = (spec['paths'] ?? {}) as Record<string, unknown>;
  for (const [apiPath, itemRaw] of Object.entries(paths)) {
    for (const [method, opRaw] of Object.entries(
      itemRaw as Record<string, unknown>
    )) {
      const responses = (opRaw as Record<string, unknown> | null)?.['responses'];
      if (!responses || typeof responses !== 'object') continue;
      for (const [status, response] of Object.entries(
        responses as Record<string, unknown>
      )) {
        found.push({
          where: `${method.toUpperCase()} ${apiPath} ${status}`,
          response: response as Record<string, unknown>,
        });
      }
    }
  }
  return found;
}

function pathLocalResponseRefs(spec: Record<string, unknown>): string[] {
  return collectResponseEntries(spec)
    .filter(
      ({ response }) =>
        typeof response?.['$ref'] === 'string' &&
        (response['$ref'] as string).startsWith('#/paths/')
    )
    .map(({ where, response }) => `${where} -> ${String(response['$ref'])}`);
}

function writeSpec(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('path-local $refs in responses maps', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-response-refs-'));

    // common-responses.yaml — shared responses, referenced cross-file like the
    // real spec. `Unauthorized` carries a header so the fixture checks that
    // inlining copies more than the content block.
    writeSpec(specDir, {
      'common-responses.yaml': `openapi: '3.0.3'
info:
  title: Common
  version: '1.0.0'
paths: {}
components:
  responses:
    Unauthorized:
      description: The request lacks valid authentication credentials.
      headers:
        WWW-Authenticate:
          schema:
            type: string
      content:
        application/problem+json:
          schema:
            $ref: '#/components/schemas/ProblemDetail'
    InternalServerError:
      description: An internal error occurred.
      content:
        application/problem+json:
          schema:
            $ref: '#/components/schemas/ProblemDetail'
  schemas:
    ProblemDetail:
      type: object
      properties:
        title:
          type: string
        status:
          type: integer
`,
      'files.yaml': `openapi: '3.0.3'
info:
  title: Files
  version: '1.0.0'
paths:
  /files/{fileKey}:
    get:
      operationId: getFile
      parameters:
        - name: fileKey
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
        '500':
          $ref: 'common-responses.yaml#/components/responses/InternalServerError'
    patch:
      operationId: updateFile
      parameters:
        - name: fileKey
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Updated
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
        '500':
          $ref: 'common-responses.yaml#/components/responses/InternalServerError'
    delete:
      operationId: deleteFile
      parameters:
        - name: fileKey
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Deleted
        '401':
          $ref: 'common-responses.yaml#/components/responses/Unauthorized'
        default:
          $ref: 'common-responses.yaml#/components/responses/InternalServerError'
`,
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /files/{fileKey}:
    $ref: 'files.yaml#/paths/~1files~1{fileKey}'
`,
    });
  });

  it('reproduces the defect: the fixture yields path-local response refs before inlining', async () => {
    // Guards the guard: if SwaggerParser stopped deduping into path-local
    // refs, the assertions below would pass vacuously.
    const result = await bundle({ specDir });
    expect(result.stats.inlinedPathLocalResponseCount).toBeGreaterThan(0);
  });

  it('leaves no path-local $ref in any responses map', async () => {
    // Deliberately NOT setting dereferencePathLocalRefs: that flag masks this.
    const result = await bundle({ specDir });
    const offenders = pathLocalResponseRefs(
      result.spec as Record<string, unknown>
    );
    expect(
      offenders,
      `path-local $refs survived in responses maps:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('preserves every response it inlines, including headers and schema refs', async () => {
    const result = await bundle({ specDir });
    const entries = collectResponseEntries(
      result.spec as Record<string, unknown>
    );
    const unauthorized = entries.filter(({ where }) => where.endsWith(' 401'));
    expect(unauthorized).toHaveLength(3);
    for (const { where, response } of unauthorized) {
      expect(response['description'], where).toBe(
        'The request lacks valid authentication credentials.'
      );
      expect(response['headers'], where).toEqual({
        'WWW-Authenticate': { schema: { type: 'string' } },
      });
      const content = response['content'] as Record<
        string,
        { schema: Record<string, unknown> }
      >;
      expect(content['application/problem+json'].schema['$ref'], where).toBe(
        '#/components/schemas/ProblemDetail'
      );
    }
    const deleteDefault = entries.find(
      ({ where }) => where === 'DELETE /files/{fileKey} default'
    );
    expect(deleteDefault?.response['description']).toBe(
      'An internal error occurred.'
    );
  });

  it('inlines independent copies, not shared object references', async () => {
    const result = await bundle({ specDir });
    const unauthorized = collectResponseEntries(
      result.spec as Record<string, unknown>
    ).filter(({ where }) => where.endsWith(' 401'));
    const distinct = new Set(unauthorized.map(({ response }) => response));
    expect(distinct.size).toBe(unauthorized.length);
  });
});

/**
 * Bad targets: each must leave the `$ref` in place, uncounted, so the
 * survivor guard throws. Class-scoped across every way a pointer can fail to
 * land on a Response Object.
 */
describe.each([
  {
    label: 'a primitive',
    ref: '#/paths/~1a/get/responses/200/description',
  },
  {
    label: 'a non-response object (a parameter)',
    ref: '#/paths/~1a/get/parameters/0',
  },
  {
    // Carries a string `description`, so a description-only shape check
    // would wrongly accept it. (A missing target never reaches this step:
    // SwaggerParser already throws MissingPointerError.)
    label: 'a schema object with a description',
    ref: '#/paths/~1a/get/parameters/0/schema',
  },
])('path-local response $ref resolving to $label', ({ ref }) => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-response-bad-'));
    writeSpec(specDir, {
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /a:
    get:
      operationId: opA
      parameters:
        - name: alpha
          in: query
          required: false
          schema:
            type: string
            description: An alpha value.
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      responses:
        '200':
          $ref: '${ref}'
`,
    });
  });

  it('throws, naming the offending ref', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived in responses maps[\s\S]*GET \/b 200/
    );
  });

  it('still throws when dereferencePathLocalRefs is enabled', async () => {
    // Step 4 dereferencing must not erase the rejected ref before the guard.
    await expect(
      bundle({ specDir, dereferencePathLocalRefs: true })
    ).rejects.toThrow(/survived in responses maps[\s\S]*GET \/b 200/);
  });

  it('leaves the $ref in place, uncounted, when bypassed', async () => {
    const result = await bundle({ specDir, allowPathLocalResponseRefs: true });
    const entries = collectResponseEntries(
      result.spec as Record<string, unknown>
    );
    const b200 = entries.find(({ where }) => where === 'GET /b 200');
    expect(b200?.response['$ref']).toBe(ref);
    expect(result.stats.inlinedPathLocalResponseCount).toBe(0);
  });
});

describe('cyclic path-local $refs in responses maps', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-response-cycle-'));
    writeSpec(specDir, {
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /a:
    get:
      operationId: opA
      responses:
        '200':
          $ref: '#/paths/~1b/get/responses/200'
  /b:
    get:
      operationId: opB
      responses:
        '200':
          $ref: '#/paths/~1a/get/responses/200'
`,
    });
  });

  it('throws rather than looping or inlining another ref', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived in responses maps/
    );
  });

  it('never counts a response it did not actually inline', async () => {
    const result = await bundle({ specDir, allowPathLocalResponseRefs: true });
    expect(result.stats.inlinedPathLocalResponseCount).toBe(0);
  });
});

/**
 * `x-*` extension entries — under `paths`, inside a Path Item, and inside a
 * `responses` map — are not responses and must be neither rewritten nor
 * rejected, even when they carry a path-local `$ref` to a non-response.
 */
describe('x-* extensions carrying path-local $refs', () => {
  let specDir: string;
  const badRef = '#/paths/~1a/get/responses/200/description';
  const goodRef = '#/paths/~1a/get/responses/200';

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-response-ext-'));
    writeSpec(specDir, {
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  x-paths-ext:
    get:
      responses:
        '200':
          $ref: '${badRef}'
  /a:
    x-item-ext:
      responses:
        '200':
          $ref: '${goodRef}'
    get:
      operationId: opA
      responses:
        '200':
          description: OK
          x-resp-ext:
            $ref: '${badRef}'
        x-map-bad:
          $ref: '${badRef}'
        x-map-good:
          $ref: '${goodRef}'
`,
    });
  });

  it('neither rejects nor rewrites extension data', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, any>;
    expect(spec.paths['x-paths-ext'].get.responses['200'].$ref).toBe(badRef);
    expect(spec.paths['/a']['x-item-ext'].responses['200'].$ref).toBe(goodRef);
    expect(spec.paths['/a'].get.responses['x-map-bad'].$ref).toBe(badRef);
    expect(spec.paths['/a'].get.responses['x-map-good'].$ref).toBe(goodRef);
    expect(result.stats.inlinedPathLocalResponseCount).toBe(0);
  });
});
