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
});
