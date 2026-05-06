/**
 * Tests for semantic-kinds.json registry bundling
 * (camunda/camunda-schema-bundler#28).
 *
 * The bundler copies `<specDir>/semantic-kinds.json` verbatim to a sibling
 * output file. When the file is absent (older refs predating
 * camunda/camunda#52322), `semanticKinds` is null and no output file is
 * written.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '../src/bundle.js';

function createMinimalSpec(dir: string): void {
  const entryYaml = `
openapi: '3.0.3'
info:
  title: Camunda REST API
  version: '8.10'
servers:
  - url: /v2
paths:
  /things:
    get:
      operationId: listThings
      responses:
        '200':
          description: OK
`.trimStart();
  fs.writeFileSync(path.join(dir, 'rest-api.yaml'), entryYaml, 'utf8');
}

const SAMPLE_REGISTRY = {
  $comment: ['Test registry fixture'],
  kinds: [
    {
      name: 'Group',
      shape: 'entity',
      identifiers: ['GroupId'],
      description: 'Test group entity.',
    },
    {
      name: 'Client',
      shape: 'external-entity',
      identifiers: ['ClientId'],
      description: 'Test external client entity.',
    },
  ],
};

describe('semantic-kinds.json registry bundling (#28)', () => {
  describe('when semantic-kinds.json is present in specDir', () => {
    let specDir: string;
    let outDir: string;
    let result: Awaited<ReturnType<typeof bundle>>;

    beforeAll(async () => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skinds-present-'));
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skinds-out-'));
      createMinimalSpec(specDir);
      // Use a deliberately non-canonical layout to verify byte-identical copy.
      const raw = JSON.stringify(SAMPLE_REGISTRY, null, 4) + '\n';
      fs.writeFileSync(path.join(specDir, 'semantic-kinds.json'), raw, 'utf8');
      result = await bundle({
        specDir,
        outputSemanticKinds: path.join(outDir, 'semantic-kinds.json'),
      });
    });

    it('exposes parsed registry on BundleResult.semanticKinds', () => {
      expect(result.semanticKinds).toEqual(SAMPLE_REGISTRY);
    });

    it('writes the registry verbatim (byte-identical to source)', () => {
      const sourceBytes = fs.readFileSync(
        path.join(specDir, 'semantic-kinds.json')
      );
      const outBytes = fs.readFileSync(path.join(outDir, 'semantic-kinds.json'));
      expect(outBytes.equals(sourceBytes)).toBe(true);
    });
  });

  describe('when semantic-kinds.json is absent from specDir', () => {
    let specDir: string;
    let outDir: string;
    let result: Awaited<ReturnType<typeof bundle>>;

    beforeAll(async () => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skinds-absent-'));
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skinds-out-'));
      createMinimalSpec(specDir);
      result = await bundle({
        specDir,
        outputSemanticKinds: path.join(outDir, 'semantic-kinds.json'),
      });
    });

    it('returns semanticKinds: null', () => {
      expect(result.semanticKinds).toBeNull();
    });

    it('does not write the output file', () => {
      expect(fs.existsSync(path.join(outDir, 'semantic-kinds.json'))).toBe(
        false
      );
    });
  });

  describe('when outputSemanticKinds is omitted but file is present', () => {
    let specDir: string;
    let result: Awaited<ReturnType<typeof bundle>>;

    beforeAll(async () => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skinds-noopt-'));
      createMinimalSpec(specDir);
      fs.writeFileSync(
        path.join(specDir, 'semantic-kinds.json'),
        JSON.stringify(SAMPLE_REGISTRY) + '\n',
        'utf8'
      );
      result = await bundle({ specDir });
    });

    it('still parses and exposes the registry on BundleResult', () => {
      expect(result.semanticKinds).toEqual(SAMPLE_REGISTRY);
    });
  });
});
