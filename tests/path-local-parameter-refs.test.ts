import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test for path-local `$ref`s surviving inside `parameters` arrays.
 *
 * `SwaggerParser.bundle()` inlines `components.parameters` (the section does
 * not survive bundling at all), then dedupes the resulting identical parameter
 * objects into path-local `$ref`s pointing at whichever operation it emitted
 * first:
 *
 *   PATCH /cluster/v2/mode:
 *     parameters:
 *       - $ref: '#/paths/~1mode/patch/parameters/0'   # mode
 *       - name: physicalTenantId ...
 *       - $ref: '#/paths/~1mode/patch/parameters/1'   # dryRun
 *
 * Step-3 signature normalization cannot rescue these: it only rewrites to
 * `#/components/schemas/*`, and there is no surviving component to point at.
 *
 * openapi-generator (Java) cannot resolve the pointers, collapses both to the
 * same unresolved value, and aborts the whole run with
 * "There are duplicate parameter values"; Microsoft.OpenApi fails similarly.
 * That took out regeneration for the Rust SDK. C# was unaffected only because
 * it passes `--deref-path-local`, which masks it.
 *
 * Parameters are never emitted as named types by any generator, so inlining is
 * lossless — unlike schemas, there is nothing to preserve by keeping a ref.
 *
 * The assertion is deliberately class-scoped: no path-local `$ref` may survive
 * in ANY `parameters` array, not just the one this fixture reproduces.
 */
describe('path-local $refs in parameters arrays', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-refs-'));

    // cluster.yaml — owns the shared parameter components. `mode` deliberately
    // uses a `$ref` schema (like the real spec) and `dryRun` an inline one, so
    // the fixture covers both shapes.
    fs.writeFileSync(
      path.join(specDir, 'cluster.yaml'),
      `openapi: '3.0.3'
info:
  title: Cluster
  version: '1.0.0'
paths:
  /mode:
    patch:
      operationId: changeClusterMode
      parameters:
        - $ref: '#/components/parameters/ModeParameter'
        - $ref: '#/components/parameters/DryRunParameter'
      responses:
        '200':
          description: OK
components:
  parameters:
    ModeParameter:
      name: mode
      in: query
      required: true
      description: The target cluster mode.
      schema:
        $ref: '#/components/schemas/Mode'
    DryRunParameter:
      name: dryRun
      in: query
      required: false
      description: Validate only.
      schema:
        type: boolean
        default: false
  schemas:
    Mode:
      type: string
      enum: [SINGLE, MULTI]
`,
      'utf8'
    );

    // cluster-admin.yaml — a second operation reusing two of cluster.yaml's
    // parameters plus one of its own. This is what triggers the dedup.
    fs.writeFileSync(
      path.join(specDir, 'cluster-admin.yaml'),
      `openapi: '3.0.3'
info:
  title: Cluster Admin
  version: '1.0.0'
paths:
  /cluster/v2/mode:
    patch:
      operationId: changeClusterModeAsClusterAdmin
      parameters:
        - $ref: 'cluster.yaml#/components/parameters/ModeParameter'
        - $ref: '#/components/parameters/PhysicalTenantIdParameter'
        - $ref: 'cluster.yaml#/components/parameters/DryRunParameter'
      responses:
        '200':
          description: OK
components:
  parameters:
    PhysicalTenantIdParameter:
      name: physicalTenantId
      in: query
      required: false
      description: The physical tenant to apply the change to.
      schema:
        type: string
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /mode:
    $ref: 'cluster.yaml#/paths/~1mode'
  /cluster/v2/mode:
    $ref: 'cluster-admin.yaml#/paths/~1cluster~1v2~1mode'
`,
      'utf8'
    );
  });

  /** Every `parameters` array in the spec, with a human-readable location. */
  function collectParameterArrays(
    spec: Record<string, unknown>
  ): { where: string; params: Record<string, unknown>[] }[] {
    const found: { where: string; params: Record<string, unknown>[] }[] = [];
    const paths = (spec['paths'] ?? {}) as Record<string, unknown>;
    for (const [apiPath, itemRaw] of Object.entries(paths)) {
      const item = itemRaw as Record<string, unknown>;
      for (const [key, valueRaw] of Object.entries(item)) {
        const params =
          key === 'parameters'
            ? valueRaw
            : (valueRaw as Record<string, unknown> | null)?.['parameters'];
        if (Array.isArray(params)) {
          found.push({
            where: key === 'parameters' ? apiPath : `${key.toUpperCase()} ${apiPath}`,
            params: params as Record<string, unknown>[],
          });
        }
      }
    }
    return found;
  }

  it('leaves no path-local $ref in any parameters array', async () => {
    // Deliberately NOT setting dereferencePathLocalRefs: that flag masks this
    // bug, which is why only the C# SDK (the one repo that passes it) was
    // unaffected.
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;

    const offenders = collectParameterArrays(spec).flatMap(({ where, params }) =>
      params
        .filter(
          (p) => typeof p?.['$ref'] === 'string' && (p['$ref'] as string).startsWith('#/paths/')
        )
        .map((p) => `${where} -> ${String(p['$ref'])}`)
    );

    expect(
      offenders,
      `path-local $refs survived in parameters arrays:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('preserves every parameter it inlines', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;
    const op = paths['/cluster/v2/mode']?.['patch'] as Record<string, unknown>;
    const params = op?.['parameters'] as Record<string, unknown>[];

    expect(params.map((p) => p['name'])).toEqual([
      'mode',
      'physicalTenantId',
      'dryRun',
    ]);
    // The parameter's own schema $ref must survive inlining.
    expect((params[0]['schema'] as Record<string, unknown>)['$ref']).toBe(
      '#/components/schemas/Mode'
    );
  });
});

/**
 * Same losslessness rule as the response side: a `description` sibling on a
 * path-local parameter `$ref` overrides the target's description and must
 * survive inlining.
 */
describe('description override on a path-local parameter $ref', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-override-'));
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
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
          description: Shared description.
          schema:
            type: string
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/get/parameters/0'
          description: Operation-specific description.
      responses:
        '200':
          description: OK
`,
      'utf8'
    );
  });

  it('keeps the sibling description when inlining the referenced parameter', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;
    const op = paths['/b']?.['get'] as Record<string, unknown>;
    const params = op?.['parameters'] as Record<string, unknown>[];

    expect(params).toHaveLength(1);
    expect(params[0]['$ref']).toBeUndefined();
    expect(params[0]['name']).toBe('alpha');
    expect(params[0]['description']).toBe('Operation-specific description.');
  });
});

describe('unresolvable path-local $refs in parameters arrays', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-bad-ref-'));

    // `/b`'s parameter points at a string, not a parameter object. Inlining it
    // would swap a parameter for a primitive and defeat the survivor check.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
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
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/get/parameters/0/name'
      responses:
        '200':
          description: OK
`,
      'utf8'
    );
  });

  it('throws rather than inlining a non-object resolution', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived inside parameters arrays/
    );
  });

  it('can be bypassed with allowPathLocalParameterRefs', async () => {
    const result = await bundle({
      specDir,
      allowPathLocalParameterRefs: true,
    });
    const paths = (result.spec as Record<string, unknown>)['paths'] as Record<
      string,
      Record<string, unknown>
    >;
    const params = (paths['/b']['get'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>[];

    // Left untouched — not replaced by the string it pointed at.
    expect(params[0]['$ref']).toBe('#/paths/~1a/get/parameters/0/name');
  });
});

describe('cyclic path-local $refs in parameters arrays', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-cycle-'));

    // `/a` and `/b` point at each other, so every resolution yields another
    // path-local ref and no substitution can ever make progress.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /a:
    get:
      operationId: opA
      parameters:
        - $ref: '#/paths/~1b/get/parameters/0'
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/get/parameters/0'
      responses:
        '200':
          description: OK
`,
      'utf8'
    );
  });

  it('never counts a parameter it did not actually inline', async () => {
    const result = await bundle({
      specDir,
      allowPathLocalParameterRefs: true,
    });

    expect(result.stats.inlinedPathLocalParameterCount).toBe(0);
  });

  it('leaves the unresolvable refs in place for the survivor check', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived inside parameters arrays/
    );
  });
});

describe('path-local parameter $refs resolving to non-parameter objects', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-shape-'));

    // `/b`'s parameter points at a response object. It is an object, so shape
    // checks alone would inline it and destroy the $ref the survivor check
    // relies on.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
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
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/get/responses/200'
      responses:
        '200':
          description: OK
`,
      'utf8'
    );
  });

  it('throws rather than inlining an object that is not a parameter', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived inside parameters arrays/
    );
  });

  it('leaves the $ref in place when bypassed', async () => {
    const result = await bundle({
      specDir,
      allowPathLocalParameterRefs: true,
    });
    const paths = (result.spec as Record<string, unknown>)['paths'] as Record<
      string,
      Record<string, unknown>
    >;
    const params = (paths['/b']['get'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>[];

    expect(params[0]['$ref']).toBe('#/paths/~1a/get/responses/200');
    expect(result.stats.inlinedPathLocalParameterCount).toBe(0);
  });
});

/**
 * With `dereferencePathLocalRefs` enabled, an aliased Path Item (`/c` →
 * `/b`) is expanded from the snapshots taken before the inlining passes, so
 * the copied parameter reference inside it still carries the sibling
 * `description` override — and naive expansion discards the override the
 * inliner applied. Mirror of the response-side aliasing regression.
 */
describe('aliased Path Item with a parameter description override under dereferencing', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-param-alias-deref-'));
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
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
          description: Shared description.
          schema:
            type: string
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/get/parameters/0'
          description: B-specific description.
      responses:
        '200':
          description: OK
  /c:
    $ref: '#/paths/~1b'
`,
      'utf8'
    );
  });

  it('preserves the parameter description override when expanding the alias', async () => {
    const result = await bundle({ specDir, dereferencePathLocalRefs: true });
    const spec = result.spec as Record<string, any>;
    const params = spec.paths['/c'].get.parameters;
    expect(params).toHaveLength(1);
    expect(params[0]['$ref']).toBeUndefined();
    expect(params[0]['name']).toBe('alpha');
    expect(params[0]['description']).toBe('B-specific description.');
  });
});
