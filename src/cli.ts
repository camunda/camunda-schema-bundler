#!/usr/bin/env node
/**
 * CLI for the Camunda Schema Bundler.
 *
 * Usage:
 *   camunda-schema-bundler [options]
 *
 * Modes:
 *   --fetch                   Fetch upstream spec before bundling (default if no --spec-dir)
 *   --spec-dir <path>         Use a local spec directory (skip fetch)
 *
 * Fetch options:
 *   --ref <ref>               Git ref to fetch (default: main)
 *   --repo-url <url>          Git repo URL (default: camunda/camunda)
 *   --output-dir <path>       Directory for fetched spec (default: external-spec/upstream/...)
 *
 * Bundle options:
 *   --entry-file <name>       Entry YAML file name (default: rest-api.yaml)
 *   --output-spec <path>      Output path for bundled JSON spec
 *   --output-metadata <path>  Output path for metadata IR JSON
 *   --deref-path-local        Inline remaining path-local $refs (for Microsoft.OpenApi)
 *   --allow-like-refs         Don't fail on surviving path-local $like refs
 *   --help                    Show help
 */
import path from 'node:path';
import { bundle } from './bundle.js';
import { fetchSpec, DEFAULT_SPEC_DIR } from './fetch.js';

interface CliArgs {
  fetch: boolean;
  specDir?: string;
  ref?: string;
  repoUrl?: string;
  outputDir?: string;
  entryFile?: string;
  outputSpec?: string;
  outputMetadata?: string;
  derefPathLocal: boolean;
  allowLikeRefs: boolean;
  skipFetchIfExists: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fetch: false,
    derefPathLocal: false,
    allowLikeRefs: false,
    skipFetchIfExists: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--fetch':
        args.fetch = true;
        break;
      case '--spec-dir':
        args.specDir = argv[++i];
        break;
      case '--ref':
        args.ref = argv[++i];
        break;
      case '--repo-url':
        args.repoUrl = argv[++i];
        break;
      case '--output-dir':
        args.outputDir = argv[++i];
        break;
      case '--entry-file':
        args.entryFile = argv[++i];
        break;
      case '--output-spec':
        args.outputSpec = argv[++i];
        break;
      case '--output-metadata':
        args.outputMetadata = argv[++i];
        break;
      case '--deref-path-local':
        args.derefPathLocal = true;
        break;
      case '--allow-like-refs':
        args.allowLikeRefs = true;
        break;
      case '--skip-fetch-if-exists':
        args.skipFetchIfExists = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return args;
}

const HELP = `
camunda-schema-bundler — Fetch & bundle Camunda multi-file OpenAPI spec

Usage:
  camunda-schema-bundler [options]

Modes:
  --fetch                   Fetch upstream spec before bundling
  --spec-dir <path>         Use existing local spec directory (skip fetch)
  If neither is given, --fetch is assumed.

Fetch options:
  --ref <ref>               Git ref to fetch (branch/tag/SHA, default: main)
  --repo-url <url>          Git repo URL (default: https://github.com/camunda/camunda.git)
  --output-dir <path>       Local dir for fetched spec (default: external-spec/upstream/...)
  --skip-fetch-if-exists    Skip fetch if the entry file already exists locally

Bundle options:
  --entry-file <name>       Entry YAML file name (default: rest-api.yaml)
  --output-spec <path>      Output path for bundled JSON spec
  --output-metadata <path>  Output path for metadata IR JSON
  --deref-path-local        Inline remaining path-local $refs
  --allow-like-refs         Don't fail on surviving path-local $like refs
  --help, -h                Show this help

Examples:
  # Fetch from upstream and bundle (simplest usage)
  camunda-schema-bundler \\
    --output-spec external-spec/bundled/rest-api.bundle.json \\
    --output-metadata external-spec/bundled/spec-metadata.json

  # Fetch a specific ref
  camunda-schema-bundler --ref stable/8.8 \\
    --output-spec rest-api.bundle.json

  # Use already-fetched spec (no network)
  camunda-schema-bundler \\
    --spec-dir external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2 \\
    --output-spec external-spec/bundled/rest-api.bundle.json

  # Bundle with path-local deref (for C# / Microsoft.OpenApi)
  camunda-schema-bundler --deref-path-local \\
    --output-spec external-spec/bundled/rest-api.bundle.json
`.trim();

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP);
    return;
  }

  let specDir: string;

  if (args.specDir) {
    // Use existing local spec directory
    specDir = args.specDir;
  } else {
    // Fetch mode (explicit --fetch or default when no --spec-dir)
    const outputDir =
      args.outputDir ??
      path.join('external-spec', 'upstream', DEFAULT_SPEC_DIR);

    console.log(
      `[camunda-schema-bundler] Fetching spec (ref: ${args.ref ?? 'main'})...`
    );

    const fetchResult = await fetchSpec({
      ref: args.ref,
      repoUrl: args.repoUrl,
      outputDir,
      entryFile: args.entryFile,
      skipIfExists: args.skipFetchIfExists,
    });

    if (fetchResult.fetched) {
      console.log(
        `[camunda-schema-bundler] Spec fetched to ${fetchResult.specDir}`
      );
    } else {
      console.log(
        `[camunda-schema-bundler] Spec already exists, skipping fetch`
      );
    }

    specDir = fetchResult.specDir;
  }

  console.log(`[camunda-schema-bundler] Bundling spec from ${specDir}`);

  const result = await bundle({
    specDir,
    entryFile: args.entryFile,
    outputSpec: args.outputSpec,
    outputMetadata: args.outputMetadata,
    dereferencePathLocalRefs: args.derefPathLocal,
    allowPathLocalLikeRefs: args.allowLikeRefs,
  });

  console.log(
    `[camunda-schema-bundler] Done: paths=${result.stats.pathCount}, ` +
      `schemas=${result.stats.schemaCount}, ` +
      `augmented=${result.stats.augmentedSchemaCount}`
  );

  if (result.stats.dereferencedPathLocalRefCount > 0) {
    console.log(
      `[camunda-schema-bundler] Dereferenced ${result.stats.dereferencedPathLocalRefCount} path-local $refs`
    );
  }

  console.log(
    `[camunda-schema-bundler] Metadata: ` +
      `semanticKeys=${result.metadata.integrity.totalSemanticKeys}, ` +
      `unions=${result.metadata.integrity.totalUnions}, ` +
      `operations=${result.metadata.integrity.totalOperations}, ` +
      `eventuallyConsistent=${result.metadata.integrity.totalEventuallyConsistent}`
  );

  if (args.outputSpec) {
    console.log(`[camunda-schema-bundler] Spec written to ${args.outputSpec}`);
  }
  if (args.outputMetadata) {
    console.log(
      `[camunda-schema-bundler] Metadata written to ${args.outputMetadata}`
    );
  }
}

main().catch((err) => {
  console.error('[camunda-schema-bundler] Fatal error:', err.message || err);
  process.exit(1);
});
