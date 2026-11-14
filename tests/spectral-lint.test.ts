import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { bundle } from '../src/bundle.js';

/**
 * Bundling must never turn a spec that lints clean into one that doesn't
 * (camunda/camunda-schema-bundler#34).
 *
 * Path-local `$ref`s that survive bundling are invalid pointers to Spectral
 * (`invalid-ref`, or `oas3-schema` "must match format uri-reference" when the
 * pointer contains `{...}`), and they are the same refs that break generators.
 * Every bundler fix for this class so far (#38 sort/items, #41 parameters) was
 * guarded only by a bespoke walker for its own instance. This guard asserts
 * the class: the bundled output has zero Spectral errors.
 *
 * Uses `@camunda8/spectral-cli`, Camunda's fork, pinned to the version
 * camunda/camunda CI uses (.github/workflows/ci.yml, SPECTRAL_VERSION). The
 * upstream `@stoplight/spectral-cli` reports false-positive pattern errors on
 * the `\p{L}` identifier patterns (stoplightio/spectral#2419), which would
 * drown out real findings when linting the real spec.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(repoRoot, 'tests', 'fixtures', 'spectral-guard');
const SPECTRAL_BIN = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'spectral.cmd' : 'spectral'
);

// Same base as camunda/camunda's zeebe/gateway-protocol/.spectral.yaml.
const RULESET = 'extends: [[spectral:oas, recommended]]\n';

// Spectral CLI start-up dominates; this is a safety net for loaded runners,
// not a correctness signal. Do not tighten it into a race.
const LINT_TIMEOUT_MS = 120_000;

interface SpectralFinding {
  code: string;
  message: string;
  severity: number;
  path: string[];
}

/**
 * Lint a spec object with Spectral and return its errors (severity 0).
 *
 * Throws if Spectral did not produce a report: a crashed or missing linter
 * must fail the test, not read as "no errors".
 */
async function spectralErrors(spec: unknown): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-spectral-'));
  const specPath = path.join(dir, 'spec.json');
  const rulesetPath = path.join(dir, '.spectral.yaml');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  fs.writeFileSync(rulesetPath, RULESET, 'utf8');

  let stderr = '';
  try {
    await execFileAsync(
      SPECTRAL_BIN,
      ['lint', specPath, '--ruleset', rulesetPath, '-f', 'json', '-o', reportPath, '-q'],
      { timeout: LINT_TIMEOUT_MS }
    );
  } catch (err) {
    // Spectral exits non-zero when it finds errors; that is a normal outcome
    // here as long as it wrote a report.
    stderr = String((err as { stderr?: unknown }).stderr ?? err);
  }
  if (!fs.existsSync(reportPath)) {
    throw new Error(
      `Spectral produced no report for ${specPath} (binary: ${SPECTRAL_BIN}).\n${stderr}`
    );
  }
  const findings = JSON.parse(
    fs.readFileSync(reportPath, 'utf8')
  ) as SpectralFinding[];
  return findings
    .filter((f) => f.severity === 0)
    .map((f) => `${f.code} at ${f.path.join('.')}: ${f.message}`);
}

describe('Spectral lint of bundled output (#34)', () => {
  beforeAll(() => {
    if (!fs.existsSync(SPECTRAL_BIN)) {
      throw new Error(
        `Spectral CLI not found at ${SPECTRAL_BIN}. Run npm install ` +
          `(@camunda8/spectral-cli is a devDependency).`
      );
    }
  });

  it(
    'guards the guard: the fixture makes SwaggerParser emit path-local $refs',
    async () => {
      // If upstream bundling stopped emitting these, the fixture would no
      // longer exercise the bundler's normalization and the guard below
      // would pass vacuously.
      const raw = await SwaggerParser.bundle(
        path.join(FIXTURE_DIR, 'rest-api.yaml')
      );
      const refs: string[] = [];
      (function walk(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        const ref = (node as Record<string, unknown>)['$ref'];
        if (typeof ref === 'string' && ref.startsWith('#/paths/')) refs.push(ref);
        for (const v of Object.values(node)) walk(v);
      })(raw);
      expect(refs.length).toBeGreaterThan(0);
    }
  );

  it(
    'guards the guard: Spectral rejects a surviving decoded path-local $ref',
    async () => {
      // The shape the bundler used to emit on main (#34): a path-local
      // pointer whose `{...}` segment has been URI-decoded. Proves the
      // linter and ruleset detect the defect class.
      const result = await bundle({ specDir: FIXTURE_DIR });
      const spec = JSON.parse(JSON.stringify(result.spec)) as {
        paths: Record<string, Record<string, { parameters: unknown[] }>>;
      };
      spec.paths['/resources/{key}/variables/search']['post'].parameters[0] = {
        $ref: '#/paths/~1resources~1{key}/delete/parameters/0',
      };
      const errors = await spectralErrors(spec);
      expect(errors.some((e) => e.startsWith('oas3-schema'))).toBe(true);
    },
    LINT_TIMEOUT_MS
  );

  it(
    'has no Spectral errors in the bundled fixture',
    async () => {
      const result = await bundle({ specDir: FIXTURE_DIR });
      const errors = await spectralErrors(result.spec);
      expect(
        errors,
        `bundling introduced Spectral errors:\n  ${errors.join('\n  ')}`
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS
  );
});
