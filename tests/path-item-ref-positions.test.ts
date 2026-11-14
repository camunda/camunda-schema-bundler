import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

function specDirWith(prefix: string, yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'rest-api.yaml'), yaml, 'utf8');
  return dir;
}

describe('path-item-level parameter reference targets', () => {
  it('inlines a ref to #/paths/<path>/parameters/<i> (Path Item parameters)', async () => {
    const specDir = specDirWith(
      'bundler-pi-param-',
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  /a:
    parameters:
      - name: alpha
        in: query
        required: false
        schema:
          type: string
    get:
      operationId: opA
      responses:
        '200':
          description: OK
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/~1a/parameters/0'
          description: B override.
      responses:
        '200':
          description: OK
`
    );
    const result = await bundle({ specDir });
    const paths = (result.spec as Record<string, unknown>)['paths'] as Record<
      string,
      Record<string, unknown>
    >;
    const params = (paths['/b']['get'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>[];
    expect(params[0]['$ref']).toBeUndefined();
    expect(params[0]['name']).toBe('alpha');
    expect(params[0]['description']).toBe('B override.');
  });

  it('rejects a parameter-shaped target under an x-* extension in paths', async () => {
    const specDir = specDirWith(
      'bundler-pi-param-ext-',
      `openapi: '3.0.3'
info:
  title: Test API
  version: '1.0.0'
paths:
  x-paths-ext:
    get:
      parameters:
        - name: fake
          in: query
  /b:
    get:
      operationId: opB
      parameters:
        - $ref: '#/paths/x-paths-ext/get/parameters/0'
          description: keep ref alive
      responses:
        '200':
          description: OK
`
    );
    await expect(bundle({ specDir })).rejects.toThrow(
      /survived inside parameters arrays/
    );
  });
});

describe('dereferencePathLocalRefs: summary overrides on Path Item aliases', () => {
  it('keeps the alias summary when the target Path Item has only method children', async () => {
    const specDir = specDirWith(
      'bundler-pi-summary-',
      `openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
paths:
  /b:
    get:
      operationId: opB
      responses:
        '200':
          description: OK
  /c:
    $ref: '#/paths/~1b'
    summary: Alias summary
`
    );
    const result = await bundle({ specDir, dereferencePathLocalRefs: true });
    const paths = (result.spec as Record<string, unknown>)['paths'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(paths['/c']['$ref']).toBeUndefined();
    expect(paths['/c']['summary']).toBe('Alias summary');
  });
});
