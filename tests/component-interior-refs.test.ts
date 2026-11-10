import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';
import { collapseComponentInteriorRefs } from '../src/helpers.js';

/**
 * Regression test for `$ref`s that point *inside* a component schema, e.g.
 * `#/components/schemas/AuthenticatedCamundaUserResult/allOf/0`.
 *
 * Upstream camunda/camunda added `AuthenticatedCamundaUserResult` as an
 * `allOf` of `CamundaUserResult`, and listed only the new schema under
 * `rest-api.yaml`'s `components.schemas`. `SwaggerParser.bundle()` therefore
 * first meets `CamundaUserResult` inside that `allOf`, inlines it there, and
 * points every other use — including the `GET /authentication/me` response —
 * at that interior location.
 *
 * Step 2 restores `CamundaUserResult` as a component and fresh dedup replaces
 * the inlined copy with `$ref: '#/components/schemas/CamundaUserResult'`, so
 * the response ends up as a ref to a ref. Neither generator can follow it:
 * openapi-python-client drops the response ("Could not find reference in
 * parsed models or enums") and the C# generator types it as `object`.
 *
 * The assertion is deliberately class-scoped: no `$ref` anywhere in the bundle
 * may point inside a component schema, not just the one this fixture
 * reproduces.
 */

const INTERIOR_COMPONENT_REF = /^#\/components\/schemas\/[^/]+\/.+/;

function collectInteriorComponentRefs(root: unknown, at = '#'): string[] {
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root)) {
    return root.flatMap((v, i) => collectInteriorComponentRefs(v, `${at}/${i}`));
  }
  const found: string[] = [];
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string' && INTERIOR_COMPONENT_REF.test(v)) {
      found.push(`${at} -> ${v}`);
    } else {
      found.push(...collectInteriorComponentRefs(v, `${at}/${k}`));
    }
  }
  return found;
}

function writeSpec(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

describe('$refs pointing inside a component schema', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-interior-refs-'));
    writeSpec(specDir, {
      'authentication.yaml': `openapi: '3.0.3'
info:
  title: Authentication
  version: '1.0.0'
paths:
  /authentication/me:
    get:
      operationId: getAuthentication
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CamundaUserResult'
components:
  schemas:
    CamundaUserResult:
      type: object
      required: [isAnonymous, username]
      properties:
        isAnonymous:
          type: boolean
        username:
          type: string
          nullable: true
    AuthenticatedCamundaUserResult:
      type: object
      allOf:
        - $ref: '#/components/schemas/CamundaUserResult'
      properties:
        isAnonymous:
          type: boolean
          enum: [false]
        username:
          type: string
`,
      // Only the derived schema is listed, as upstream does. This is what makes
      // SwaggerParser inline the base schema into the allOf.
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /authentication/me:
    $ref: 'authentication.yaml#/paths/~1authentication~1me'
components:
  schemas:
    AuthenticatedCamundaUserResult:
      $ref: 'authentication.yaml#/components/schemas/AuthenticatedCamundaUserResult'
`,
    });
  });

  it('leaves no $ref pointing inside a component schema', async () => {
    const result = await bundle({ specDir });
    const offenders = collectInteriorComponentRefs(result.spec);

    expect(
      offenders,
      `$refs into component interiors survived:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('points the response at the named base component', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, any>;
    const schema =
      spec.paths['/authentication/me'].get.responses['200'].content['application/json'].schema;

    expect(schema).toEqual({ $ref: '#/components/schemas/CamundaUserResult' });
    expect(spec.components.schemas.AuthenticatedCamundaUserResult.allOf).toEqual([
      { $ref: '#/components/schemas/CamundaUserResult' },
    ]);
  });
});

describe('unresolvable $refs pointing inside a component schema', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-interior-refs-bad-'));
    // The interior target is an inline schema that is not, and does not match,
    // any component. There is no named type to retarget to, so the bundle must
    // not be emitted silently.
    writeSpec(specDir, {
      'rest-api.yaml': `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /things:
    get:
      operationId: getThing
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Wrapper/properties/inner'
components:
  schemas:
    Wrapper:
      type: object
      properties:
        inner:
          type: object
          properties:
            onlyHere:
              type: string
`,
    });
  });

  it('throws, naming the offending ref', async () => {
    await expect(bundle({ specDir })).rejects.toThrow(
      /#\/components\/schemas\/Wrapper\/properties\/inner/
    );
  });

  it('can be bypassed with allowComponentInteriorRefs', async () => {
    const result = await bundle({ specDir, allowComponentInteriorRefs: true });
    expect(result.stats.componentInteriorRefCount).toBe(1);
  });
});

describe('collapseComponentInteriorRefs', () => {
  const INTERIOR = '#/components/schemas/Wrapper/properties/inner';

  function doc(extra: Record<string, unknown> = {}): Record<string, any> {
    return {
      paths: {},
      components: {
        schemas: {
          Base: { type: 'object', properties: { id: { type: 'string' } } },
          Wrapper: {
            type: 'object',
            properties: { inner: { $ref: '#/components/schemas/Base' } },
          },
          Opaque: {
            type: 'object',
            properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } },
          },
        },
      },
      ...extra,
    };
  }

  it('follows bare $refs through non-component locations to a component', () => {
    const spec = doc({
      paths: {
        '/a': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Base' } },
                },
              },
            },
          },
        },
        '/b': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: INTERIOR } } },
              },
            },
          },
        },
      },
    });
    spec.components.schemas.Wrapper.properties.inner = {
      $ref: '#/paths/~1a/get/responses/200/content/application~1json/schema',
    };

    const result = collapseComponentInteriorRefs(spec);

    expect(result.unresolved).toEqual([]);
    expect(spec.paths['/b'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Base',
    });
  });

  it('reports a cycle of bare $refs as unresolved instead of looping', () => {
    const spec = doc();
    spec.components.schemas.Wrapper.properties.inner = {
      $ref: '#/components/schemas/Wrapper/properties/other',
    };
    spec.components.schemas.Wrapper.properties.other = { $ref: INTERIOR };
    spec.paths = { '/c': { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: INTERIOR } } } } } } } };

    const result = collapseComponentInteriorRefs(spec);

    expect(result.collapsed).toBe(0);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });

  // Payload keywords hold literal instance data, not OpenAPI references. A
  // `$ref` key inside them must be neither rewritten nor reported.
  it.each([
    ['example', (v: unknown) => ({ type: 'object', example: v })],
    ['default', (v: unknown) => ({ type: 'object', default: v })],
    ['enum', (v: unknown) => ({ type: 'object', enum: [v] })],
    ['const', (v: unknown) => ({ type: 'object', const: v })],
    ['examples (schema array)', (v: unknown) => ({ type: 'object', examples: [v] })],
  ])('leaves literal $ref values under %s untouched', (_label, wrap) => {
    for (const target of [INTERIOR, '#/components/schemas/Opaque/properties/inner']) {
      const spec = doc();
      spec.components.schemas.Payload = wrap({ $ref: target });
      const before = JSON.stringify(spec.components.schemas.Payload);

      const result = collapseComponentInteriorRefs(spec);

      expect(result).toEqual({ collapsed: 0, unresolved: [] });
      expect(JSON.stringify(spec.components.schemas.Payload)).toBe(before);
    }
  });

  it('leaves literal $ref values in Example Objects untouched', () => {
    const spec = doc({
      paths: {
        '/d': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Base' },
                    examples: {
                      sample: { value: { $ref: '#/components/schemas/Opaque/properties/inner' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const before = JSON.stringify(spec.paths);

    expect(collapseComponentInteriorRefs(spec)).toEqual({ collapsed: 0, unresolved: [] });
    expect(JSON.stringify(spec.paths)).toBe(before);
  });

  // The same words are structural when they name a map entry rather than a
  // keyword: a `default` response, or a schema property called `example`,
  // `default` or `value`. Refs there must still be retargeted.
  it('still retargets refs under map entries that share a payload keyword name', () => {
    const spec = doc({
      paths: {
        '/e': {
          get: {
            responses: {
              default: {
                description: 'Error',
                content: { 'application/json': { schema: { $ref: INTERIOR } } },
              },
            },
          },
        },
      },
    });
    spec.components.schemas.Holder = {
      type: 'object',
      properties: {
        example: { $ref: INTERIOR },
        default: { $ref: INTERIOR },
        value: { $ref: INTERIOR },
        enum: { $ref: INTERIOR },
      },
    };

    const result = collapseComponentInteriorRefs(spec);

    expect(result).toEqual({ collapsed: 5, unresolved: [] });
    expect(spec.paths['/e'].get.responses.default.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Base',
    });
    for (const p of ['example', 'default', 'value', 'enum']) {
      expect(spec.components.schemas.Holder.properties[p]).toEqual({
        $ref: '#/components/schemas/Base',
      });
    }
  });
});
