/**
 * Fetch the upstream Camunda OpenAPI spec via a sparse git clone.
 *
 * Mirrors the fetch logic from the JS and C# SDKs, consolidated here
 * so every consuming SDK uses the same mechanism.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface FetchOptions {
  /** Git repository URL. Default: https://github.com/camunda/camunda.git */
  repoUrl?: string;

  /** Git ref (branch, tag, SHA) to fetch. Default: "main" */
  ref?: string;

  /** Spec directory path relative to the repo root. */
  specDir?: string;

  /** Entry file name inside the spec directory. Default: "rest-api.yaml" */
  entryFile?: string;

  /** Local directory to write the fetched spec into. */
  outputDir: string;

  /**
   * If true and the entry file already exists locally, skip fetching.
   * Useful for publish-time integrity checks to avoid spec drift.
   */
  skipIfExists?: boolean;
}

export interface FetchResult {
  /** Absolute path to the fetched spec directory. */
  specDir: string;

  /** Absolute path to the entry YAML file. */
  entryPath: string;

  /** Whether the fetch was actually performed (false if skipped). */
  fetched: boolean;
}

const DEFAULT_REPO_URL = 'https://github.com/camunda/camunda.git';
const DEFAULT_REF = 'main';
const DEFAULT_SPEC_DIR = 'zeebe/gateway-protocol/src/main/proto/v2';
const DEFAULT_ENTRY_FILE = 'rest-api.yaml';

/**
 * Fetch the upstream spec via sparse git clone.
 *
 * This does a depth-1, blob-filtered, sparse-checkout clone of the
 * Camunda monorepo, extracting only the OpenAPI spec directory.
 * The result is copied into `outputDir` and the temporary clone is removed.
 */
export async function fetchSpec(options: FetchOptions): Promise<FetchResult> {
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
  const ref = options.ref ?? DEFAULT_REF;
  const specDir = options.specDir ?? DEFAULT_SPEC_DIR;
  const entryFile = options.entryFile ?? DEFAULT_ENTRY_FILE;
  const outputDir = resolve(options.outputDir);

  const entryPath = join(outputDir, entryFile);

  if (options.skipIfExists && existsSync(entryPath)) {
    return { specDir: outputDir, entryPath, fetched: false };
  }

  const tmpDir = join(outputDir, '..', '.tmp-clone-' + Date.now());

  try {
    mkdirSync(tmpDir, { recursive: true });

    const run = (args: string[]) =>
      execFileSync(args[0], args.slice(1), { stdio: 'pipe', timeout: 120_000 });

    run(['git', 'clone', '--depth', '1', '--branch', ref, '--filter=blob:none', '--sparse', repoUrl, tmpDir]);
    run(['git', '-C', tmpDir, 'sparse-checkout', 'init', '--no-cone']);
    run(['git', '-C', tmpDir, 'sparse-checkout', 'set', `/${specDir}`]);
    // Force checkout to populate tree with sparse-checkout patterns
    run(['git', '-C', tmpDir, 'checkout']);

    const sourceDir = resolve(tmpDir, specDir);
    const sourceEntry = resolve(sourceDir, entryFile);

    if (!existsSync(sourceEntry)) {
      throw new Error(
        `Upstream spec entry not found at ${sourceEntry} (ref: ${ref})`
      );
    }

    // Replace existing output dir to avoid stale files
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
    cpSync(sourceDir, outputDir, { recursive: true });

    return { specDir: outputDir, entryPath, fetched: true };
  } finally {
    // Always clean up the temporary clone
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export { DEFAULT_REPO_URL, DEFAULT_REF, DEFAULT_SPEC_DIR, DEFAULT_ENTRY_FILE };
