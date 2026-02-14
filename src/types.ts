/**
 * Type definitions for the Camunda Schema Bundler.
 */

// ── Bundle options ───────────────────────────────────────────────────────────

export interface FetchAndBundleOptions {
  /** Git ref (branch, tag, SHA) to fetch from the upstream repo. Default: "main" */
  ref?: string;

  /** Git repository URL. Default: https://github.com/camunda/camunda.git */
  repoUrl?: string;

  /** Upstream spec directory relative to repo root. */
  specDir?: string;

  /** Local directory to write the fetched spec into. */
  outputDir: string;

  /** Entry YAML file name (default: "rest-api.yaml"). */
  entryFile?: string;

  /** Output path for the bundled JSON spec. */
  outputSpec?: string;

  /** Output path for the metadata IR JSON. */
  outputMetadata?: string;

  /** Manual ref overrides. */
  manualOverrides?: Record<string, string>;

  /** If true, inline remaining path-local $refs. */
  dereferencePathLocalRefs?: boolean;

  /** If true, allow surviving path-local $like refs. */
  allowPathLocalLikeRefs?: boolean;

  /** If true and spec already exists locally, skip fetching. */
  skipFetchIfExists?: boolean;
}

export interface BundleOptions {
  /** Path to the upstream spec directory containing multi-file YAML. */
  specDir: string;

  /** Entry YAML file name (default: "rest-api.yaml"). */
  entryFile?: string;

  /** Output path for the bundled JSON spec. */
  outputSpec?: string;

  /** Output path for the metadata IR JSON. */
  outputMetadata?: string;

  /**
   * Manual ref overrides: map of path-local $ref → component schema name.
   * Used for known tricky paths that can't be resolved by signature matching.
   */
  manualOverrides?: Record<string, string>;

  /**
   * If true, also inline (dereference) remaining path-local $refs.
   * Required for generators that can't resolve #/paths/... refs (e.g. Microsoft.OpenApi).
   * Default: false.
   */
  dereferencePathLocalRefs?: boolean;

  /**
   * If true, allow surviving path-local $like refs without failing.
   * Default: false (fail-fast).
   */
  allowPathLocalLikeRefs?: boolean;
}

export interface BundleResult {
  /** The bundled OpenAPI spec as a plain object. */
  spec: Record<string, unknown>;

  /** Extracted metadata / intermediate representation. */
  metadata: SpecMetadata;

  /** Stats about the bundling process. */
  stats: BundleStats;
}

export interface BundleStats {
  pathCount: number;
  schemaCount: number;
  augmentedSchemaCount: number;
  promotedInlineSchemaCount: number;
  freshDedupCount: number;
  dereferencedPathLocalRefCount: number;
  pathLocalLikeRefCount: number;
}

// ── Metadata IR ──────────────────────────────────────────────────────────────

export interface SpecMetadata {
  schemaVersion: string;

  /** SHA-256 hash of the upstream spec directory tree for drift detection. */
  specHash: string;

  /** Schemas marked with x-semantic-type or x-semantic-key. */
  semanticKeys: SemanticKeyEntry[];

  /** Union/variant types (oneOf/anyOf structures). */
  unions: UnionEntry[];

  /** Array schemas with bounds. */
  arrays: ArraySchemaEntry[];

  /** Operations with eventual consistency markers. */
  eventuallyConsistentOps: EventuallyConsistentOp[];

  /** All operation summaries. */
  operations: OperationSummary[];

  /** Integrity counters for validation. */
  integrity: {
    totalSemanticKeys: number;
    totalUnions: number;
    totalOperations: number;
    totalEventuallyConsistent: number;
  };
}

export interface SemanticKeyEntry {
  name: string;
  semanticType: string;
  category: 'system-key' | 'cursor' | 'model-id' | 'other';
  description?: string;
  composition: {
    schemaKind: 'allOf' | 'oneOf' | 'anyOf' | 'inline';
    refs: string[];
    inlineFragments: number;
  };
  constraints: SchemaConstraints;
  examples?: string[];
  extensions?: Record<string, unknown>;
  flags: {
    semanticKey: boolean;
    includesLongKeyRef: boolean;
    deprecated: boolean;
  };
  stableId: string;
}

export interface UnionEntry {
  name: string;
  kind: 'union-wrapper' | 'hybrid-union';
  description?: string;
  branches: UnionBranch[];
  stableId: string;
}

export interface UnionBranch {
  branchType: 'ref' | 'composed' | 'uuid' | 'other';
  ref?: string;
  refs?: string[];
  constraints?: SchemaConstraints;
}

export interface ArraySchemaEntry {
  name: string;
  itemRef?: string;
  itemType?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface EventuallyConsistentOp {
  operationId: string;
  path: string;
  method: string;
  tags: string[];
}

export interface OperationSummary {
  operationId: string;
  path: string;
  method: string;
  tags: string[];
  summary?: string;
  description?: string;
  eventuallyConsistent: boolean;
  hasRequestBody: boolean;
  requestBodyUnion: boolean;

  /** True when the operation has a JSON-like body and no path/query parameters. */
  bodyOnly: boolean;

  /** Names of path parameters (e.g. ['processInstanceKey']). */
  pathParams: string[];

  /** Query parameters with required flag. */
  queryParams: OperationQueryParam[];

  /** For union request bodies: the $ref target schema names. */
  requestBodyUnionRefs: string[];

  /** Whether the (resolved) request body has an optional tenantId property. */
  optionalTenantIdInBody: boolean;
}

export interface OperationQueryParam {
  name: string;
  required: boolean;
}

export interface SchemaConstraints {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  format?: string;
}
