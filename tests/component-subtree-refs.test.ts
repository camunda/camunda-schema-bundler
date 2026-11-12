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
    expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(1);
    expect(
      (doc.paths['/a'].get.responses['200'].content['application/json'].schema as any).$ref
    ).toBe('#/components/schemas/Named');
  });

  it('follows a bare #/paths/ intermediary to the named component', () => {
    const doc: any = schemaAt('#/components/schemas/ViaPath/allOf/0', {
      ViaPath: { allOf: [{ $ref: '#/paths/~1c/get/responses/200/content/application~1json/schema' }] },
    });
    doc.paths['/c'] = {
      get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Named' } } } } } },
    };
    const { collapsed, survivors } = collapseComponentSubtreeRefs(doc);
    expect(survivors).toEqual([]);
    expect(collapsed).toBe(1);
    expect(doc.paths['/a'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/Named'
    );
  });

  it('survives a cycle through a #/paths/ intermediary', () => {
    const ref = '#/components/schemas/PathLoop/allOf/0';
    const doc: any = schemaAt(ref, {
      PathLoop: { allOf: [{ $ref: '#/paths/~1c/get/responses/200/content/application~1json/schema' }] },
    });
    doc.paths['/c'] = {
      get: { responses: { '200': { content: { 'application/json': { schema: { $ref: ref } } } } } },
    };
    const { survivors } = collapseComponentSubtreeRefs(doc);
    expect(survivors).toContain(ref);
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
    it(`survives when the chain ends at ${label}`, () => {
      const { collapsed, survivors } = collapseComponentSubtreeRefs(schemaAt(ref, extra));
      expect(collapsed).toBe(0);
      expect(survivors).toEqual([ref]);
    });
  }

  describe('leaves $ref-like literal payloads untouched', () => {
    // Non-bare target: collapsing would throw if these were treated as refs.
    const literal = { $ref: '#/components/schemas/Wrapper/allOf' };
    const positions: Array<[string, (mt: Record<string, any>) => void, (mt: Record<string, any>) => unknown]> = [
      ['media type example', (mt) => (mt.example = literal), (mt) => mt.example],
      ['Example Object value', (mt) => (mt.examples = { e: { value: literal } }), (mt) => mt.examples.e.value],
      ['schema default', (mt) => (mt.schema.default = literal), (mt) => mt.schema.default],
      ['schema enum', (mt) => (mt.schema.enum = [literal]), (mt) => mt.schema.enum[0]],
      ['schema const', (mt) => (mt.schema.const = literal), (mt) => mt.schema.const],
      ['schema examples array', (mt) => (mt.schema.examples = [literal]), (mt) => mt.schema.examples[0]],
      ['extension', (mt) => (mt['x-data'] = literal), (mt) => mt['x-data']],
    ];
    for (const [label, set, get] of positions) {
      it(label, () => {
        const doc = schemaAt('#/components/schemas/Named') as any;
        const mt = doc.paths['/b'].get.responses['200'].content['application/json'];
        set(mt);
        expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(0);
        expect(get(mt)).toEqual({ $ref: '#/components/schemas/Wrapper/allOf' });
      });
    }

    for (const name of ['default', 'enum', 'const', 'example', 'examples', 'x-data']) {
      it(`still collapses a real ref in a property named ${name}`, () => {
        const doc = schemaAt('#/components/schemas/Named') as any;
        const prop = { $ref: '#/components/schemas/Wrapper/allOf/0' };
        doc.components.schemas.Holder = { type: 'object', properties: { [name]: prop } };
        expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(1);
        expect(prop.$ref).toBe('#/components/schemas/Named');
      });
    }

    // Maps keyed by user-chosen names: an entry named like a literal keyword
    // is still an OpenAPI object and must be collapsed / validated.
    const realRef = () => ({ $ref: '#/components/schemas/Wrapper/allOf/0' });
    const namedEntries: Array<[string, (doc: any, schema: object) => void]> = [
      ['response named default', (doc, schema) => {
        doc.paths['/b'].get.responses.default = { description: 'd', content: { 'application/json': { schema } } };
      }],
      ['component schema named default', (doc, schema) => (doc.components.schemas.default = { allOf: [schema] })],
      ['component schema named x-data', (doc, schema) => (doc.components.schemas['x-data'] = { allOf: [schema] })],
      ['component response named default', (doc, schema) => {
        doc.components.responses = { default: { description: 'd', content: { 'application/json': { schema } } } };
      }],
      ['media type in content map named example', (doc, schema) => {
        doc.paths['/b'].get.responses['200'].content.example = { schema };
      }],
      // Example/Link maps are keyed by user-chosen names too: an `x-*` entry
      // is a named Example/Link Object (or a Reference to one), not extension
      // data — only nameMapExt maps (responses/paths/webhooks/callbacks)
      // reserve `x-*` for extensions.
      ['component example named x-data', (doc, schema) => {
        doc.components.examples = { 'x-data': { summary: 's', externalValue: 'u', extra: schema } };
      }],
      ['component link named x-data', (doc, schema) => {
        doc.components.links = { 'x-data': { operationId: 'x', external: { wrapped: schema } } };
      }],
      ['media-type example named x-data', (doc, schema) => {
        doc.paths['/b'].get.responses['200'].content['application/json'].examples = {
          'x-data': { summary: 's', externalValue: 'u', extra: schema },
        };
      }],
      ['response link named x-data', (doc, schema) => {
        doc.paths['/b'].get.responses['200'].links = { 'x-data': { operationId: 'x', external: { wrapped: schema } } };
      }],
      ['component example that is itself a Reference named x-data', (doc, schema) => {
        doc.components.examples = { 'x-data': schema };
      }],
      ['component link that is itself a Reference named x-data', (doc, schema) => {
        doc.components.links = { 'x-data': schema };
      }],
    ];
    for (const [label, place] of namedEntries) {
      it(`still collapses a real ref in a ${label}`, () => {
        const doc = schemaAt('#/components/schemas/Named') as any;
        const schema = realRef();
        place(doc, schema);
        expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(1);
        expect(schema.$ref).toBe('#/components/schemas/Named');
      });
      it(`still reports a dangling ref in a ${label}`, () => {
        const doc = schemaAt('#/components/schemas/Named') as any;
        place(doc, { $ref: '#/components/schemas/Wrapper/allOf' });
        const { survivors } = collapseComponentSubtreeRefs(doc);
        expect(survivors).toEqual(['#/components/schemas/Wrapper/allOf']);
      });
    }

    const dataPositions: Array<[string, (doc: any) => unknown]> = [
      ['response-map extension', (doc) => (doc.paths['/b'].get.responses['x-data'] = { ...literal })],
      ['paths extension', (doc) => (doc.paths['x-data'] = { ...literal })],
      ['components extension', (doc) => (doc.components['x-data'] = { ...literal })],
      ['Link Object requestBody', (doc) => {
        const v = { ...literal };
        doc.paths['/b'].get.responses['200'].links = { l: { operationId: 'x', requestBody: v } };
        return v;
      }],
      ['Link Object parameters', (doc) => {
        const v = { ...literal };
        doc.paths['/b'].get.responses['200'].links = { l: { operationId: 'x', parameters: { p: v } } };
        return v;
      }],
      ['component Link requestBody', (doc) => {
        const v = { ...literal };
        doc.components.links = { L: { operationId: 'x', requestBody: v } };
        return v;
      }],
    ];
    for (const [label, place] of dataPositions) {
      it(`leaves a ${label} untouched`, () => {
        const doc = schemaAt('#/components/schemas/Named') as any;
        const v = place(doc) as Record<string, unknown>;
        expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(0);
        expect(v).toEqual(literal);
      });
    }

    it('still collapses a real ref next to an examples map', () => {
      const doc = schemaAt('#/components/schemas/Wrapper/allOf/0') as any;
      const mt = doc.paths['/a'].get.responses['200'].content['application/json'];
      mt.examples = { e: { value: literal } };
      expect(collapseComponentSubtreeRefs(doc).collapsed).toBe(1);
      expect(mt.schema.$ref).toBe('#/components/schemas/Named');
    });
  });
});
