/**
 * Convenience function that fetches the upstream spec and bundles it in one call.
 */
import path from 'node:path';
import { fetchSpec, DEFAULT_SPEC_DIR } from './fetch.js';
import { bundle } from './bundle.js';
import type { FetchAndBundleOptions, BundleResult } from './types.js';

/**
 * Fetch the upstream Camunda OpenAPI spec and bundle it in a single call.
 *
 * This is the simplest way to go from zero to a bundled spec + metadata IR.
 */
export async function fetchAndBundle(
  options: FetchAndBundleOptions
): Promise<BundleResult> {
  const outputDir =
    options.outputDir ??
    path.join('external-spec', 'upstream', DEFAULT_SPEC_DIR);

  const fetchResult = await fetchSpec({
    repoUrl: options.repoUrl,
    ref: options.ref,
    specDir: options.specDir,
    entryFile: options.entryFile,
    outputDir,
    skipIfExists: options.skipFetchIfExists,
  });

  return bundle({
    specDir: fetchResult.specDir,
    entryFile: options.entryFile,
    outputSpec: options.outputSpec,
    outputMetadata: options.outputMetadata,
    manualOverrides: options.manualOverrides,
    dereferencePathLocalRefs: options.dereferencePathLocalRefs,
    allowPathLocalLikeRefs: options.allowPathLocalLikeRefs,
  });
}
