import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

/**
 * Regression test for camunda/camunda-schema-bundler#32.
 *
 * When `SwaggerParser.bundle()` inlines a `$ref` from a sub-file whose
 * target lives in the root entry's `components/schemas`, the original
 * ref *name* is erased from the operation site. If the upstream spec
 * defines several named structural aliases for the same shape (e.g.
 * `MappingRuleCreate{,Update}Result` — both `{ allOf: [$ref: Inner] }`),
 * the post-bundle `freshSignatureDedup` step sees N candidates and the
 * 2.4.0 fail-hard path triggers — even though the upstream YAML was
 * unambiguous.
 *
 * This is dangerous for nominally typed downstream SDKs (Python/C#)
 * because picking the wrong alias is a source-breaking type-name
 * change driven by sort order, not by spec intent.
 *
 * Class-scoped: this file builds a multi-file fixture exercising the
 * shape across **three** named structural aliases (so a
 * pick-by-sort-order workaround would still pick the wrong one for at
 * least one operation), and asserts that **every** operation site
 * resolves to the alias the upstream YAML named at that site.
 */
describe('cross-file $ref name preservation (#32)', () => {
  let specDir: string;
  let bundled: Record<string, unknown>;

  beforeAll(async () => {
    specDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bundler-issue-32-')
    );

    // models.yaml — defines three same-shape aliases. They live in a
    // separate file from the operations that reference them, mirroring
    // the upstream Camunda layout (mapping-rules.yaml ops referring to
    // root-file aliases via cross-file `$ref`).
    fs.writeFileSync(
      path.join(specDir, 'models.yaml'),
      `openapi: '3.0.3'
info:
  title: Models
  version: '1.0.0'
paths: {}
components:
  schemas:
    Inner:
      type: object
      properties:
        id:
          type: string
    MappingRuleCreateResult:
      type: object
      allOf:
        - $ref: '#/components/schemas/Inner'
    MappingRuleUpdateResult:
      type: object
      allOf:
        - $ref: '#/components/schemas/Inner'
    MappingRuleUpsertResult:
      type: object
      allOf:
        - $ref: '#/components/schemas/Inner'
`
    );

    // ops.yaml — three operations, each naming a *different* alias via
    // a cross-file $ref. Post-bundle, `SwaggerParser.bundle()` inlines
    // each schema and erases the alias name, leaving three byte-identical
    // `{ allOf: [$ref: Inner] }` shapes that signature-match all three
    // candidates.
    fs.writeFileSync(
      path.join(specDir, 'ops.yaml'),
      `openapi: '3.0.3'
info:
  title: Sub
  version: '1.0.0'
paths:
  /create:
    post:
      operationId: create
      responses:
        '201':
          description: created
          content:
            application/json:
              schema:
                $ref: 'models.yaml#/components/schemas/MappingRuleCreateResult'
  /update:
    put:
      operationId: update
      responses:
        '200':
          description: updated
          content:
            application/json:
              schema:
                $ref: 'models.yaml#/components/schemas/MappingRuleUpdateResult'
  /upsert:
    post:
      operationId: upsert
      responses:
        '200':
          description: upserted
          content:
            application/json:
              schema:
                $ref: 'models.yaml#/components/schemas/MappingRuleUpsertResult'
`
    );

    // rest-api.yaml — root entry, refs the sub-file's path items.
    fs.writeFileSync(
      path.join(specDir, 'rest-api.yaml'),
      `openapi: '3.0.3'
info:
  title: Issue 32 fixture
  version: '1.0.0'
paths:
  /create:
    $ref: 'ops.yaml#/paths/~1create'
  /update:
    $ref: 'ops.yaml#/paths/~1update'
  /upsert:
    $ref: 'ops.yaml#/paths/~1upsert'
`
    );

    const result = await bundle({ specDir });
    bundled = result.spec;
  });

  function refOf(method: string, apiPath: string, status: string): string | undefined {
    const paths = bundled['paths'];
    if (!paths || typeof paths !== 'object') return undefined;
    const item = (paths as Record<string, unknown>)[apiPath];
    if (!item || typeof item !== 'object') return undefined;
    const op = (item as Record<string, unknown>)[method];
    if (!op || typeof op !== 'object') return undefined;
    const responses = (op as Record<string, unknown>)['responses'];
    if (!responses || typeof responses !== 'object') return undefined;
    const resp = (responses as Record<string, unknown>)[status];
    if (!resp || typeof resp !== 'object') return undefined;
    const content = (resp as Record<string, unknown>)['content'];
    if (!content || typeof content !== 'object') return undefined;
    const json = (content as Record<string, unknown>)['application/json'];
    if (!json || typeof json !== 'object') return undefined;
    const schema = (json as Record<string, unknown>)['schema'];
    if (!schema || typeof schema !== 'object') return undefined;
    const ref = (schema as Record<string, unknown>)['$ref'];
    return typeof ref === 'string' ? ref : undefined;
  }

  it('POST /create response 201 keeps MappingRuleCreateResult', () => {
    expect(refOf('post', '/create', '201')).toBe(
      '#/components/schemas/MappingRuleCreateResult'
    );
  });

  it('PUT /update response 200 keeps MappingRuleUpdateResult', () => {
    expect(refOf('put', '/update', '200')).toBe(
      '#/components/schemas/MappingRuleUpdateResult'
    );
  });

  it('POST /upsert response 200 keeps MappingRuleUpsertResult', () => {
    expect(refOf('post', '/upsert', '200')).toBe(
      '#/components/schemas/MappingRuleUpsertResult'
    );
  });
});
