import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { bundle } from '../src/bundle.js';
import { fetchSpec } from '../src/fetch.js';

// Self-contained integration test: fetches spec into a temp dir within this project.
// Set CAMUNDA_BUNDLER_INTEGRATION=1 to run (skipped by default since it clones from GitHub).
const RUN_INTEGRATION =
  process.env['CAMUNDA_BUNDLER_INTEGRATION'] === '1';

const SPEC_DIR = path.join(os.tmpdir(), 'camunda-schema-bundler-test-spec');

describe.skipIf(!RUN_INTEGRATION)('bundle (integration)', () => {
  beforeAll(async () => {
    // Fetch the upstream spec into a temp directory
    await fetchSpec({
      outputDir: SPEC_DIR,
      skipIfExists: true,
    });
  }, 120_000); // generous timeout for git clone

  it('bundles the upstream spec with correct schema count', async () => {
    const result = await bundle({ specDir: SPEC_DIR });
    expect(result.stats.schemaCount).toBeGreaterThanOrEqual(460);
    expect(result.stats.pathCount).toBeGreaterThanOrEqual(100);
    expect(result.stats.pathLocalLikeRefCount).toBe(0);
  });

  it('extracts semantic keys', async () => {
    const result = await bundle({ specDir: SPEC_DIR });
    expect(result.metadata.semanticKeys.length).toBeGreaterThan(25);

    const pik = result.metadata.semanticKeys.find(
      (k) => k.name === 'ProcessInstanceKey'
    );
    expect(pik).toBeDefined();
    expect(pik!.flags.includesLongKeyRef).toBe(true);
  });

  it('detects eventually consistent operations', async () => {
    const result = await bundle({ specDir: SPEC_DIR });
    expect(result.metadata.eventuallyConsistentOps.length).toBeGreaterThan(0);
  });

  it('fetches by raw commit SHA', async () => {
    // Known historical commit on camunda/camunda main containing the v2 spec.
    const sha = '2b2b962a312b86586ade7547d513783371db32a2';
    const shaSpecDir = path.join(os.tmpdir(), `camunda-schema-bundler-test-sha-${sha.slice(0, 8)}`);
    if (fs.existsSync(shaSpecDir)) fs.rmSync(shaSpecDir, { recursive: true, force: true });
    const result = await fetchSpec({ outputDir: shaSpecDir, ref: sha });
    expect(result.fetched).toBe(true);
    expect(fs.existsSync(result.entryPath)).toBe(true);
  }, 120_000);

  it('dereferences path-local refs when requested', async () => {
    const result = await bundle({
      specDir: SPEC_DIR,
      dereferencePathLocalRefs: true,
    });

    let pathLocal = 0;
    const stack: unknown[] = [result.spec];
    const seen = new Set<unknown>();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      const obj = node as Record<string, unknown>;
      if (
        typeof obj['$ref'] === 'string' &&
        (obj['$ref'] as string).startsWith('#/paths/')
      )
        pathLocal++;
      for (const v of Object.values(obj)) stack.push(v);
    }

    expect(pathLocal).toBe(0);
    expect(result.stats.dereferencedPathLocalRefCount).toBeGreaterThan(0);
  });

  it('builds endpoint map with entries for all paths', async () => {
    const result = await bundle({ specDir: SPEC_DIR });
    expect(result.endpointMap).toBeDefined();
    // Each path can have multiple methods, so endpoint count >= path count
    expect(Object.keys(result.endpointMap).length).toBeGreaterThanOrEqual(result.stats.pathCount);

    for (const [operation, entry] of Object.entries(result.endpointMap)) {
      expect(operation).toBeTruthy();
      expect(entry).toBeTruthy();
      expect(entry.file).toMatch(/\.ya?ml$/);
      // operationId may be null for operations that don't declare one
      expect(entry.operationId === null || typeof entry.operationId === 'string').toBe(true);
    }
  });

  it('writes endpoint map to disk when outputEndpointMap is set', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'camunda-schema-bundler-endpoint-map-')
    );
    const outPath = path.join(tempDir, 'endpoint-map.json');

    try {
      const result = await bundle({
        specDir: SPEC_DIR,
        outputEndpointMap: outPath,
      });

      expect(fs.existsSync(outPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(Object.keys(written).length).toBe(Object.keys(result.endpointMap).length);
    } finally {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      fs.rmdirSync(tempDir);
    }
  });
});
