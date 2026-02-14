/**
 * camunda-schema-bundler
 *
 * Bundle the Camunda multi-file OpenAPI spec into a single JSON file
 * with schema normalization and metadata extraction.
 */
export { bundle } from './bundle.js';
export { fetchSpec } from './fetch.js';
export { fetchAndBundle } from './fetch-and-bundle.js';
export type {
  BundleOptions,
  BundleResult,
  BundleStats,
  FetchAndBundleOptions,
  SpecMetadata,
  SemanticKeyEntry,
  UnionEntry,
  UnionBranch,
  ArraySchemaEntry,
  EventuallyConsistentOp,
  OperationSummary,
  SchemaConstraints,
} from './types.js';
export type { FetchOptions, FetchResult } from './fetch.js';
export {
  hashDirectoryTree,
  listFilesRecursive,
  findPathLocalLikeRefs,
} from './helpers.js';
