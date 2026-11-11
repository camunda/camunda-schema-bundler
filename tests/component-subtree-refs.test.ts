import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle, collapseComponentSubtreeRefs } from '../src/bundle.js';

/**
 * Regression test for `$ref`s that point *into* a component schema's subtree.
 *
 * Upstream `authentication.yaml` (camunda/camunda 1df63b8507) has:
 *
 *   GET /authentication/me -> 200 -> $ref: '#/components/schemas/CamundaUserResult'
 *   AuthenticatedCamundaUserResult:
 *     allOf:
 *       - $ref: '#/components/schemas/CamundaUserResult'
 *
 * and `rest-api.yaml` registers only `AuthenticatedCamundaUserResult`.
 * `SwaggerParser.bundle()` reaches `CamundaUserResult` through that `allOf`
 * first, so the operation's ref is emitted as the JSON pointer
 * `#/components/schemas/AuthenticatedCamundaUserResult/allOf/0`. The pointer
 * resolves, but generators name its target after the pointer: openapi-generator
 * (PHP) emitted a non-existent `Model0` return type for `getAuthentication()`.
 *
 * The assertions are class-scoped: no `$ref` anywhere in the bundle may point
 * inside a component, not just the one this fixture reproduces.
 */
describe('$refs into a component subtree', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-component-subtree-refs-'));

    fs.writeFileSync(
      path.join(specDir, 'authentication.yaml'),
      `openapi: '3.0.3'
info:
  title: Authentication
  version: '1.0.0'
paths:
  /authentication/me:
    get:
      operationId: getAuthentication
      responses:
        '200':
          description: The current user.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CamundaUserResult'
components:
  schemas:
    CamundaUserResult:
      type: object
      properties:
        isAnonymous:
          type: boolean
        username:
          type: string
          nullable: true
    AuthenticatedCamundaUserResult:
      description: A CamundaUserResult with an identity.
      type: object
      allOf:
        - $ref: '#/components/schemas/CamundaUserResult'
      properties:
        isAnonymous:
          type: boolean
          enum: [false]
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
  /authentication/me:
    $ref: 'authentication.yaml#/paths/~1authentication~1me'
components:
  schemas:
    AuthenticatedCamundaUserResult:
      $ref: 'authentication.yaml#/components/schemas/AuthenticatedCamundaUserResult'
`,
      'utf8'
    );
  });

  function collectRefs(node: unknown, at: string, out: string[]): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => collectRefs(v, `${at}/${i}`, out));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') out.push(`${at} -> ${v}`);
      else collectRefs(v, `${at}/${k}`, out);
    }
  }

  for (const dereferencePathLocalRefs of [false, true]) {
    describe(`dereferencePathLocalRefs=${dereferencePathLocalRefs}`, () => {
      it('leaves no $ref pointing inside a component schema', async () => {
        const result = await bundle({ specDir, dereferencePathLocalRefs });
        const refs: string[] = [];
        collectRefs(result.spec, '#', refs);
        const offenders = refs.filter((r) =>
          /-> #\/components\/[^/]+\/[^/]+\/./.test(r)
        );
        expect(
          offenders,
          `$refs into a component subtree survived:\n  ${offenders.join('\n  ')}`
        ).toEqual([]);
      });

      it('points the operation at the named component', async () => {
        const result = await bundle({ specDir, dereferencePathLocalRefs });
        const spec = result.spec as Record<string, any>;
        expect(
          spec.paths['/authentication/me'].get.responses['200'].content['application/json']
            .schema
        ).toEqual({ $ref: '#/components/schemas/CamundaUserResult' });
        expect(spec.components.schemas.CamundaUserResult).toBeDefined();
      });
    });
  }

  it('collapses subtree refs reintroduced by path-local dereferencing', async () => {
    // A second path reusing the same path item is emitted as a `#/paths/...`
    // ref; Step 4 copies it from a snapshot taken before the collapse pass.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-subtree-deref-'));
    for (const f of ['authentication.yaml', 'rest-api.yaml']) {
      fs.copyFileSync(path.join(specDir, f), path.join(dir, f));
    }
    const rest = fs
      .readFileSync(path.join(dir, 'rest-api.yaml'), 'utf8')
      .replace(
        'components:',
        "  /authentication/me2:\n    $ref: 'authentication.yaml#/paths/~1authentication~1me'\ncomponents:"
      );
    fs.writeFileSync(path.join(dir, 'rest-api.yaml'), rest, 'utf8');

    const result = await bundle({ specDir: dir, dereferencePathLocalRefs: true });
    const refs: string[] = [];
    collectRefs(result.spec, '#', refs);
    expect(refs.filter((r) => /-> #\/components\/[^/]+\/[^/]+\/./.test(r))).toEqual([]);
    const spec = result.spec as Record<string, any>;
    for (const p of ['/authentication/me', '/authentication/me2']) {
      expect(
        spec.paths[p].get.responses['200'].content['application/json'].schema
      ).toEqual({ $ref: '#/components/schemas/CamundaUserResult' });
    }
  });
});

describe('collapseComponentSubtreeRefs', () => {
  const schemaAt = (ref: string, extra: Record<string, unknown> = {}) => ({
    paths: {
      '/a': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: ref } } } } } } },
      '/b': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } } },
    },
    components: {
      schemas: {
        Named: { type: 'object' },
        Wrapper: { allOf: [{ $ref: '#/components/schemas/Named' }] },
        ...extra,
      },
    },
  });

  it('rewrites a subtree ref to the named component it resolves to', () => {
    const doc = schemaAt('#/components/schemas/Wrapper/allOf/0');
    expect(collapseComponentSubtreeRefs(doc)).toBe(1);
    expect(
      (doc.paths['/a'].get.responses['200'].content['application/json'].schema as any).$ref
    ).toBe('#/components/schemas/Named');
  });

  for (const [label, ref, extra] of [
    ['an unnamed #/paths/ schema', '#/components/schemas/ToPath/allOf/0', {
      ToPath: { allOf: [{ $ref: '#/paths/~1b/get/responses/200/content/application~1json/schema' }] },
    }],
    ['a missing component', '#/components/schemas/ToMissing/allOf/0', {
      ToMissing: { allOf: [{ $ref: '#/components/schemas/DoesNotExist' }] },
    }],
    ['a non-$ref subtree', '#/components/schemas/Wrapper/allOf', {}],
    ['a $ref cycle', '#/components/schemas/Loop/allOf/0', {
      Loop: { allOf: [{ $ref: '#/components/schemas/Loop/allOf/0' }] },
    }],
  ] as const) {
    it(`throws when the chain ends at ${label}`, () => {
      expect(() => collapseComponentSubtreeRefs(schemaAt(ref, extra))).toThrow(
        /point inside a component schema/
      );
    });
  }
});
