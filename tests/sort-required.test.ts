import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sortRequiredArrays } from '../src/helpers.js';
import { bundle } from '../src/bundle.js';

/**
 * Regression guard for camunda/camunda-schema-bundler#35:
 *
 * `required` arrays must be emitted in deterministic (sorted) order so that
 * bundling the same upstream spec twice produces byte-identical output.
 */

describe('sortRequiredArrays', () => {
  it('sorts every required array in place, recursively', () => {
    const doc = {
      components: {
        schemas: {
          Foo: {
            type: 'object',
            required: ['page', 'items'],
            properties: {
              nested: {
                type: 'object',
                required: ['b', 'a', 'c'],
              },
            },
          },
        },
      },
    };
    sortRequiredArrays(doc);
    expect(doc.components.schemas.Foo.required).toEqual(['items', 'page']);
    expect(
      (
        doc.components.schemas.Foo.properties.nested as { required: string[] }
      ).required
    ).toEqual(['a', 'b', 'c']);
  });

  it('leaves non-string-array `required` values alone', () => {
    // OpenAPI Parameter Object uses `required: boolean` — must not touch it.
    const doc = {
      paths: {
        '/x': {
          get: {
            parameters: [{ name: 'q', in: 'query', required: true }],
          },
        },
      },
    };
    sortRequiredArrays(doc);
    expect(doc.paths['/x'].get.parameters[0].required).toBe(true);
  });

  it('tolerates cycles without infinite-looping', () => {
    const a: Record<string, unknown> = { required: ['z', 'a'] };
    a['self'] = a;
    expect(() => sortRequiredArrays(a)).not.toThrow();
    expect(a['required']).toEqual(['a', 'z']);
  });
});

describe('bundle output: required arrays are deterministic (#35)', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-required-order-')
    );

    // Monolithic spec with an unsorted top-level `required` array on an
    // inline request-body schema and on a nested component schema.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: t
  version: '1.0.0'
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [page, items, cursor]
              properties:
                page: { type: integer }
                items: { type: array, items: { type: string } }
                cursor: { type: string }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Result'
components:
  schemas:
    Result:
      type: object
      required: [zeta, alpha, mu]
      properties:
        zeta: { type: string }
        alpha: { type: string }
        mu: { type: string }
`,
      'utf8'
    );
  });

  it('emits sorted `required` arrays everywhere in the bundled spec', async () => {
    const r = await bundle({ specDir, entryFile: 'rest-api.yaml' });
    const spec = r.spec as Record<string, unknown>;

    const components = spec['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<
      string,
      { required?: string[] }
    >;
    expect(schemas['Result'].required).toEqual(['alpha', 'mu', 'zeta']);

    // Walk the whole document and assert every string[] `required` array
    // is sorted ascending.
    const stack: unknown[] = [spec];
    const seen = new Set<unknown>();
    let stringRequiredArraysSeen = 0;
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (const i of cur) stack.push(i);
        continue;
      }
      const obj = cur as Record<string, unknown>;
      const req = obj['required'];
      if (Array.isArray(req) && req.every((x) => typeof x === 'string')) {
        stringRequiredArraysSeen++;
        const sorted = [...(req as string[])].sort();
        expect(req).toEqual(sorted);
      }
      for (const v of Object.values(obj)) stack.push(v);
    }
    expect(stringRequiredArraysSeen).toBeGreaterThanOrEqual(2);
  });

  it('produces byte-identical output across two bundler runs', async () => {
    const a = await bundle({ specDir, entryFile: 'rest-api.yaml' });
    const b = await bundle({ specDir, entryFile: 'rest-api.yaml' });
    expect(JSON.stringify(a.spec)).toEqual(JSON.stringify(b.spec));
  });
});

/**
 * Stronger invariant for #35: the bundled output must be invariant under
 * permutation of upstream `required` arrays. This locks in that the
 * normalization runs BEFORE signature-based dedup / ambiguity detection
 * (Step 2b), not just before serialization. If the sort were applied
 * after signature computation, two upstreams differing only in
 * `required` order could produce different dedup decisions and the
 * bundles would diverge — even though the final `required` arrays were
 * each individually sorted.
 *
 * See PR #36 review thread.
 */
describe('bundle is invariant under upstream `required`-order permutations (#35)', () => {
  function makeSpec(inlineRequired: string[], componentRequired: string[]) {
    return {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': {
                  // Inline schema structurally identical to ItemRequest
                  // except for `required` order.
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      value: { type: 'integer' },
                      tag: { type: 'string' },
                    },
                    required: inlineRequired,
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
          ItemRequest: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'integer' },
              tag: { type: 'string' },
            },
            required: componentRequired,
          },
        },
      },
    };
  }

  async function bundleSpec(spec: object): Promise<string> {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-required-perm-')
    );
    fs.writeFileSync(
      path.join(dir, 'rest-api.yaml'),
      JSON.stringify(spec, null, 2),
      'utf8'
    );
    const r = await bundle({ specDir: dir });
    return JSON.stringify(r.spec);
  }

  it('dedups inline schema to its component even when `required` order differs', async () => {
    // Inline has [tag, name, value]; component has [name, value, tag].
    // With normalization running BEFORE Step 3 signature matching, both
    // canonicalize to the same signature and the inline dedups to a $ref.
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-required-dedup-')
    );
    fs.writeFileSync(
      path.join(dir, 'rest-api.yaml'),
      JSON.stringify(
        makeSpec(['tag', 'name', 'value'], ['name', 'value', 'tag']),
        null,
        2
      ),
      'utf8'
    );

    const result = await bundle({ specDir: dir });
    const bundledSpec = result.spec as {
      paths: Record<
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
    };

    const ref =
      bundledSpec.paths['/items']?.post?.requestBody?.content?.[
        'application/json'
      ]?.schema?.$ref;
    expect(ref).toBe('#/components/schemas/ItemRequest');
  });

  it('two upstreams differing only in `required` order produce identical bundles', async () => {
    // Three distinct permutations of the same set should all produce
    // byte-identical bundled JSON.
    const a = await bundleSpec(
      makeSpec(['name', 'value', 'tag'], ['name', 'value', 'tag'])
    );
    const b = await bundleSpec(
      makeSpec(['tag', 'name', 'value'], ['value', 'tag', 'name'])
    );
    const c = await bundleSpec(
      makeSpec(['value', 'name', 'tag'], ['tag', 'name', 'value'])
    );
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
