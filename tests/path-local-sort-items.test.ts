import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test: path-local $refs to sort/items must be resolved to the
 * correct component schema even when multiple component schemas share the
 * same structure (ambiguous signature).
 *
 * Real-world scenario from Camunda v10 spec:
 * - UserTaskVariableSearchQuerySortRequest and VariableSearchQuerySortRequest
 *   are structurally identical (same field enum, same order $ref).
 * - /user-tasks/{key}/variables/search declares sort.items inline (should be
 *   UserTaskVariableSearchQuerySortRequest).
 * - /user-tasks/{key}/effective-variables/search references the first endpoint's
 *   sort/items via a path-local $ref.
 *
 * After bundling, both endpoints' sort.items MUST resolve to proper component
 * $refs, not remain as path-local refs or unresolved inline objects.
 */
describe('path-local sort/items with ambiguous signatures', () => {
  let specDir: string;

  beforeAll(() => {
    // Create a multi-file spec that reproduces the bug.
    // Files MUST be written as YAML (not JSON) so the monolithic-detection
    // regex in isMonolithicEntryFile sees `$ref: 'file.yaml#...'` patterns.
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-sort-items-test-')
    );

    // search-models.yaml — shared schemas
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
    SearchQueryRequest:
      type: object
      properties:
        size:
          type: integer
`,
      'utf8'
    );

    // resources.yaml — two identical sort schemas, two endpoints
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
              description: Effective variable search request.
              additionalProperties: false
              type: object
              properties:
                sort:
                  description: Sort field criteria.
                  type: array
                  items:
                    $ref: '#/paths/~1resources~1{key}~1variables~1search/post/requestBody/content/application~1json/schema/properties/sort/items'
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
        sort:
          description: Sort field criteria.
          type: array
          items:
            $ref: '#/paths/~1resources~1{key}~1variables~1search/post/requestBody/content/application~1json/schema/properties/sort/items'
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

  it('resolves sort/items to component $ref when signature is ambiguous', async () => {
    const result = await bundle({
      specDir,
      dereferencePathLocalRefs: true,
    });
    const spec = result.spec as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;
    const schemas = (spec['components'] as Record<string, unknown>)[
      'schemas'
    ] as Record<string, unknown>;

    // Both sort request schemas must exist
    expect(schemas['ResourceVariableSearchQuerySortRequest']).toBeDefined();
    expect(schemas['VariableSearchQuerySortRequest']).toBeDefined();

    // Helper to extract sort.items ref from a path's POST request body.
    // The request body schema may be:
    // 1. A $ref to a component request schema (best case — dedup replaced it)
    // 2. Inline with sort.items as a $ref
    // 3. Inline with sort.items still inline (the bug)
    function getSortItemsRef(apiPath: string): string | undefined {
      const post = paths[apiPath]?.['post'] as Record<string, unknown>;
      const body = post?.['requestBody'] as Record<string, unknown>;
      const content = body?.['content'] as Record<string, unknown>;
      const json = content?.['application/json'] as Record<string, unknown>;
      const schema = json?.['schema'] as Record<string, unknown>;
      if (!schema) return undefined;

      // Case 1: entire request body was deduped to a component $ref
      if (typeof schema['$ref'] === 'string') {
        const refName = (schema['$ref'] as string).replace(
          '#/components/schemas/',
          ''
        );
        const componentSchema = schemas[refName] as Record<string, unknown>;
        const props = componentSchema?.['properties'] as Record<
          string,
          unknown
        >;
        const sort = props?.['sort'] as Record<string, unknown>;
        const items = sort?.['items'] as Record<string, unknown>;
        return items?.['$ref'] as string | undefined;
      }

      // Case 2/3: inline schema — check sort.items directly
      const props = schema['properties'] as Record<string, unknown>;
      const sort = props?.['sort'] as Record<string, unknown>;
      const items = sort?.['items'] as Record<string, unknown>;
      return items?.['$ref'] as string | undefined;
    }

    const variablesRef = getSortItemsRef('/resources/{key}/variables/search');
    const effectiveRef = getSortItemsRef(
      '/resources/{key}/effective-variables/search'
    );

    // Bug 1: The effective-variables endpoint must NOT have a path-local $ref
    expect(
      effectiveRef?.startsWith('#/paths/'),
      `effective-variables sort.items has path-local ref: ${effectiveRef}`
    ).not.toBe(true);

    // Bug 2: sort.items must resolve to a proper component $ref
    expect(
      variablesRef,
      'variables sort.items should be a $ref to a component schema, not inline'
    ).toBeDefined();

    // The variables endpoint (which uses a direct component $ref for sort.items)
    // must reference ResourceVariableSearchQuerySortRequest
    expect(variablesRef).toBe(
      '#/components/schemas/ResourceVariableSearchQuerySortRequest'
    );

    // The effective-variables endpoint's request body was deduped to a $ref
    // pointing to ResourceEffectiveVariableSearchQueryRequest. That component
    // schema originally had a path-local $ref for sort.items which was
    // dereferenced to inline. Component schemas are not walked by dedup
    // (they are the source of truth), so sort.items remains inline there.
    // What matters is that the path-level schema was properly deduped and
    // no path-local refs survive (verified by the next test).
    const effPost = paths['/resources/{key}/effective-variables/search']?.[
      'post'
    ] as Record<string, unknown>;
    const effBody = effPost?.['requestBody'] as Record<string, unknown>;
    const effContent = effBody?.['content'] as Record<string, unknown>;
    const effJson = effContent?.['application/json'] as Record<string, unknown>;
    const effSchema = effJson?.['schema'] as Record<string, unknown>;
    expect(
      typeof effSchema?.['$ref'] === 'string',
      'effective-variables request body should be deduped to a component $ref'
    ).toBe(true);
    expect(effSchema?.['$ref']).toBe(
      '#/components/schemas/ResourceEffectiveVariableSearchQueryRequest'
    );
  });

  it('no path-local $refs survive anywhere in bundled paths', async () => {
    const result = await bundle({
      specDir,
      dereferencePathLocalRefs: true,
    });
    const spec = result.spec as Record<string, unknown>;

    // Walk the entire spec and find any path-local $refs
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
    walk(spec['paths'], '#/paths');

    expect(
      pathLocalRefs,
      `Path-local $refs survived bundling:\n${pathLocalRefs.join('\n')}`
    ).toHaveLength(0);
  });
});

describe('ambiguous inline detection (hard failure)', () => {
  let specDir: string;

  beforeAll(() => {
    // Create a spec where two component schemas are structurally identical
    // but NO reverse-ref context exists to disambiguate them. The inline
    // schema in the path matches both — disambiguation must fail.
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-ambiguous-fail-test-')
    );

    // A single-file spec (monolithic) with ambiguous inline schemas.
    // Neither SortA nor SortB is referenced by any component schema, so
    // the reverse-ref index provides no disambiguation signal.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Ambiguous Test
  version: '1.0.0'
paths:
  /things/search:
    post:
      operationId: searchThings
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                sort:
                  type: array
                  items:
                    type: object
                    properties:
                      field:
                        type: string
                        enum: [name, age]
                      order:
                        type: string
                        enum: [ASC, DESC]
      responses:
        '200':
          description: OK
components:
  schemas:
    SortA:
      type: object
      properties:
        field:
          type: string
          enum: [name, age]
        order:
          type: string
          enum: [ASC, DESC]
    SortB:
      type: object
      properties:
        field:
          type: string
          enum: [name, age]
        order:
          type: string
          enum: [ASC, DESC]
`,
      'utf8'
    );
  });

  it('throws when ambiguous inlines cannot be disambiguated', async () => {
    await expect(
      bundle({
        specDir,
        dereferencePathLocalRefs: true,
      })
    ).rejects.toThrow(/ambiguous inline schema/i);
  });

  it('lists the candidates in the error message', async () => {
    await expect(
      bundle({
        specDir,
        dereferencePathLocalRefs: true,
      })
    ).rejects.toThrow(/SortA.*SortB|SortB.*SortA/);
  });

  it('succeeds when allowAmbiguousInlines is set', async () => {
    const result = await bundle({
      specDir,
      dereferencePathLocalRefs: true,
      allowAmbiguousInlines: true,
    });
    expect(result.stats.ambiguousInlineCount).toBeGreaterThan(0);
  });
});
