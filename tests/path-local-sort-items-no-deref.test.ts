import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test for the real-world Camunda spec failure that the original
 * `path-local-sort-items.test.ts` did NOT catch because it ran with
 * `dereferencePathLocalRefs: true` (which inlines the surviving ref and masks
 * the bug).
 *
 * The downstream SDKs (e.g. orchestration-cluster-api-rust) bundle WITHOUT
 * `--deref-path-local`. In that mode, the `effective-variables/search`
 * endpoint's `sort.items` survives as an unresolved path-local `$ref`:
 *
 *   #/paths/~1resources~1{key}~1variables~1search/post/requestBody/content/
 *     application~1json/schema/properties/sort/items
 *
 * Root cause: `SwaggerParser.bundle()` dedupes the shared `sort.items` subtree
 * between two structurally-identical alias schemas
 * (ResourceVariableSearchQuerySortRequest / VariableSearchQuerySortRequest).
 * Step-3 signature normalization fails because the snapshot-resolved inline has
 * its nested `order` $ref inlined, so it matches NO component signature.
 *
 * The pointer is also dangling for strict JSON-Pointer consumers (it walks
 * `.../schema/properties/...` where `schema` is itself a `$ref`), so
 * openapi-generator emits a bare `Object`.
 *
 * After bundling (without deref), the endpoint's `sort.items` MUST resolve to
 * the correct component `$ref`, and no path-local schema ref may survive.
 */
describe('path-local sort/items survives without deref (real-world regression)', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-sort-items-noderef-')
    );

    // search-models.yaml — shared schemas (note: `order` is a $ref, like the
    // real spec; this is what breaks exact-signature matching of the inlined
    // snapshot copy).
    fs.writeFileSync(
      path.join(specDir, 'search-models.yaml'),
      `openapi: '3.0.3'
info:
  title: Search Models
  version: '1.0.0'
paths: {}
components:
  schemas:
    SortOrderEnum:
      type: string
      enum: [ASC, DESC]
    OffsetPagination:
      type: object
      properties:
        from:
          type: integer
    SearchQueryRequest:
      type: object
      properties:
        size:
          type: integer
`,
      'utf8'
    );

    // resources.yaml — two DISTINCT request schemas that share an identical
    // sort-request alias. Both endpoints reference their request schema via a
    // clean component $ref (exactly like the upstream Camunda spec).
    fs.writeFileSync(
      path.join(specDir, 'resources.yaml'),
      `openapi: '3.0.3'
info:
  title: Resources
  version: '1.0.0'
paths:
  /resources/{key}/variables/search:
    post:
      operationId: searchResourceVariables
      parameters:
        - name: key
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ResourceVariableSearchQueryRequest'
      responses:
        '200':
          description: OK
  /resources/{key}/effective-variables/search:
    post:
      operationId: searchResourceEffectiveVariables
      parameters:
        - name: key
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ResourceEffectiveVariableSearchQueryRequest'
      responses:
        '200':
          description: OK
components:
  schemas:
    ResourceVariableSearchQuerySortRequest:
      type: object
      properties:
        field:
          description: The field to sort by.
          type: string
          enum: [value, name, tenantId, variableKey]
        order:
          $ref: 'search-models.yaml#/components/schemas/SortOrderEnum'
      required: [field]
    VariableSearchQuerySortRequest:
      type: object
      properties:
        field:
          description: The field to sort by.
          type: string
          enum: [value, name, tenantId, variableKey]
        order:
          $ref: 'search-models.yaml#/components/schemas/SortOrderEnum'
      required: [field]
    ResourceVariableSearchQueryRequest:
      allOf:
        - $ref: 'search-models.yaml#/components/schemas/SearchQueryRequest'
      description: Resource variable search request.
      additionalProperties: false
      type: object
      properties:
        sort:
          description: Sort field criteria.
          type: array
          items:
            $ref: '#/components/schemas/ResourceVariableSearchQuerySortRequest'
    ResourceEffectiveVariableSearchQueryRequest:
      description: Effective variable search request.
      additionalProperties: false
      type: object
      properties:
        page:
          allOf:
            - $ref: 'search-models.yaml#/components/schemas/OffsetPagination'
        sort:
          description: Sort field criteria.
          type: array
          items:
            $ref: '#/components/schemas/ResourceVariableSearchQuerySortRequest'
`,
      'utf8'
    );

    // rest-api.yaml — entry point (must use YAML $ref syntax)
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /resources/{key}/variables/search:
    $ref: 'resources.yaml#/paths/~1resources~1{key}~1variables~1search'
  /resources/{key}/effective-variables/search:
    $ref: 'resources.yaml#/paths/~1resources~1{key}~1effective-variables~1search'
`,
      'utf8'
    );
  });

  it('resolves effective-variables sort/items to a component $ref without deref', async () => {
    // NOTE: deliberately NOT setting dereferencePathLocalRefs — this is how
    // the downstream Rust/Python SDKs bundle.
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;

    function getSortItemsRef(apiPath: string): unknown {
      const post = paths[apiPath]?.['post'] as Record<string, unknown>;
      const body = post?.['requestBody'] as Record<string, unknown>;
      const content = body?.['content'] as Record<string, unknown>;
      const json = content?.['application/json'] as Record<string, unknown>;
      let schema = json?.['schema'] as Record<string, unknown>;
      // Request body may have been deduped to a component $ref.
      if (typeof schema?.['$ref'] === 'string') {
        const name = (schema['$ref'] as string).replace(
          '#/components/schemas/',
          ''
        );
        const schemas = (spec['components'] as Record<string, unknown>)[
          'schemas'
        ] as Record<string, unknown>;
        schema = schemas[name] as Record<string, unknown>;
      }
      const props = schema?.['properties'] as Record<string, unknown>;
      const sort = props?.['sort'] as Record<string, unknown>;
      const items = sort?.['items'] as Record<string, unknown>;
      return items?.['$ref'];
    }

    const effRef = getSortItemsRef(
      '/resources/{key}/effective-variables/search'
    );

    expect(
      effRef,
      `effective-variables sort.items must resolve to a component $ref, got: ${String(
        effRef
      )}`
    ).toBe('#/components/schemas/ResourceVariableSearchQuerySortRequest');
  });

  it('no path-local $refs survive anywhere in bundled paths (no deref)', async () => {
    const result = await bundle({ specDir });
    const spec = result.spec as Record<string, unknown>;

    const pathLocalRefs: string[] = [];
    function walk(node: unknown, jsonPath: string): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${jsonPath}[${i}]`));
        return;
      }
      const obj = node as Record<string, unknown>;
      if (
        typeof obj['$ref'] === 'string' &&
        (obj['$ref'] as string).startsWith('#/paths/')
      ) {
        pathLocalRefs.push(`${jsonPath}: ${obj['$ref']}`);
      }
      for (const [key, val] of Object.entries(obj)) {
        walk(val, `${jsonPath}.${key}`);
      }
    }
    // Only inspect schema positions: response refs (#/paths/.../responses/...)
    // are a legitimate, separate category and are out of scope here.
    walk(
      (spec['paths'] as Record<string, unknown>),
      '#/paths'
    );

    const schemaPathLocalRefs = pathLocalRefs.filter((r) =>
      r.includes('/schema/')
    );

    expect(
      schemaPathLocalRefs,
      `Schema-level path-local $refs survived bundling:\n${schemaPathLocalRefs.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });
});
