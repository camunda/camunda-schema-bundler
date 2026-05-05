# camunda-schema-bundler

Bundle the Camunda multi-file OpenAPI spec into a single normalized JSON file with schema normalization and metadata extraction (intermediate representation).

Used by the [TypeScript](https://github.com/camunda/orchestration-cluster-api-js), [C#](https://github.com/camunda/orchestration-cluster-api-csharp), and [Python](https://github.com/camunda/orchestration-cluster-api-python) Camunda SDKs to produce a clean, generator-ready OpenAPI spec from the upstream multi-file YAML source.

## Why?

The upstream Camunda REST API spec is split across many YAML files. When bundled naïvely (e.g. with `SwaggerParser.bundle()`), the result contains:

- **Path-local `$ref`s** (`#/paths/...`) that many generators can't handle
- **Missing component schemas** from files that SwaggerParser doesn't walk
- **URI-encoded refs** (`%24like` instead of `$like`) that confuse generators
- **Inline duplicates** of schemas that should be component refs

This utility solves all of these problems and produces three outputs:

1. **Bundled spec** (`rest-api.bundle.json`) — A single, clean OpenAPI 3 JSON file with all schemas as proper `#/components/schemas/...` refs
2. **Metadata IR** (`spec-metadata.json`) — A structured intermediate representation of domain-specific information extracted from the spec
3. **Endpoint map** (`endpoint-map.json`) — _Deprecated, removed in 3.0.0._ Each `OperationSummary` in `spec-metadata.json` now carries `sourceFile` directly, so consumers no longer need to read this file or join on `"METHOD /path"`. Still emitted (with a deprecation warning) when `--output-endpoint-map` is set, for one minor cycle.

## Installation

### npm

```bash
npm install camunda-schema-bundler
```

### Standalone Binary

Pre-built binaries (no Node.js required) are available from [GitHub Releases](https://github.com/camunda/camunda-schema-bundler/releases):

```bash
# Download (example: macOS ARM64)
curl -fsSL -o camunda-schema-bundler \
  https://github.com/camunda/camunda-schema-bundler/releases/latest/download/camunda-schema-bundler-darwin-arm64
chmod +x camunda-schema-bundler

# Use it
./camunda-schema-bundler --help
```

Available binaries:

| Platform | File |
|---|---|
| Linux x64 | `camunda-schema-bundler-linux-x64` |
| Linux ARM64 | `camunda-schema-bundler-linux-arm64` |
| macOS x64 | `camunda-schema-bundler-darwin-x64` |
| macOS ARM64 | `camunda-schema-bundler-darwin-arm64` |
| Windows x64 | `camunda-schema-bundler-windows-x64.exe` |

## CLI Usage

```bash
# Fetch from upstream and bundle (simplest usage — fetches from main)
camunda-schema-bundler \
  --output-spec external-spec/bundled/rest-api.bundle.json \
  --output-metadata external-spec/bundled/spec-metadata.json

# Fetch a specific branch/tag/SHA
camunda-schema-bundler --ref stable/8.8 \
  --output-spec rest-api.bundle.json

# Auto-detect upstream ref from current git branch
# (main → main, stable/* → stable/*, other → main)
camunda-schema-bundler --auto-ref \
  --output-spec external-spec/bundled/rest-api.bundle.json

# Use already-fetched spec (no network)
camunda-schema-bundler \
  --spec-dir external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2 \
  --output-spec external-spec/bundled/rest-api.bundle.json

# Generate endpoint map (tracks which source file each endpoint came from)
camunda-schema-bundler \
  --output-spec external-spec/bundled/rest-api.bundle.json \
  --output-endpoint-map external-spec/bundled/endpoint-map.json

# Bundle with path-local deref (for C# / Microsoft.OpenApi)
camunda-schema-bundler --deref-path-local \
  --output-spec external-spec/bundled/rest-api.bundle.json

# Check version
camunda-schema-bundler --version
```

### CLI Options

| Option | Description |
|---|---|
| **Modes** | |
| `--fetch` | Fetch upstream spec before bundling (default when no `--spec-dir`) |
| `--spec-dir <path>` | Use an existing local spec directory (skip fetch) |
| **Fetch options** | |
| `--ref <ref>` | Git ref to fetch: branch, tag, or SHA (default: `main`) |
| `--auto-ref` | Auto-detect ref from current git branch or `SPEC_REF` env var |
| `--repo-url <url>` | Git repo URL (default: `https://github.com/camunda/camunda.git`) |
| `--output-dir <path>` | Local directory for fetched spec files |
| `--skip-fetch-if-exists` | Skip fetch if the entry file already exists locally |
| **Bundle options** | |
| `--entry-file <name>` | Entry YAML file name (default: `rest-api.yaml`) |
| `--output-spec <path>` | Output path for the bundled JSON spec |
| `--output-metadata <path>` | Output path for the metadata IR JSON |
| `--output-endpoint-map <path>` | _Deprecated, removed in 3.0.0._ Output path for the endpoint map JSON (method + path → source file). Use `OperationSummary.sourceFile` in `spec-metadata.json` instead. |
| `--deref-path-local` | Inline remaining path-local `$ref`s (needed for Microsoft.OpenApi) |
| `--allow-like-refs` | Don't fail on surviving path-local `$like` refs |
| **General** | |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

### Auto-ref detection

The `--auto-ref` flag (and `detectUpstreamRef()` in the library API) resolves the upstream spec ref using this priority:

1. `SPEC_REF` environment variable (always wins)
2. Current git branch: `main` → `main`, `stable/X.Y` → `stable/X.Y`
3. Falls back to `main` for other branches or if git is unavailable

## Library API

### `bundle()` — Bundle from a local spec directory

```typescript
import { bundle } from 'camunda-schema-bundler';

const result = await bundle({
  specDir: 'external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2',
  outputSpec: 'external-spec/bundled/rest-api.bundle.json',
  outputMetadata: 'external-spec/bundled/spec-metadata.json',
  outputEndpointMap: 'external-spec/bundled/endpoint-map.json',
  dereferencePathLocalRefs: false, // set true for C# / Python
});

console.log(result.stats);
// {
//   pathCount: 140, schemaCount: 511, augmentedSchemaCount: 511,
//   promotedInlineSchemaCount: 46, freshDedupCount: 298,
//   dereferencedPathLocalRefCount: 0, pathLocalLikeRefCount: 0
// }

console.log(result.endpointMap);
// {
//   "GET /process-instances": "process-instance.yaml",
//   "POST /process-instances": "process-instance.yaml",
//   ...
// }
```

### `fetchAndBundle()` — Fetch + bundle in one call

```typescript
import { fetchAndBundle } from 'camunda-schema-bundler';

const result = await fetchAndBundle({
  ref: 'stable/8.8',                // optional, default: "main"
  outputDir: 'external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2',
  outputSpec: 'external-spec/bundled/rest-api.bundle.json',
  outputMetadata: 'external-spec/bundled/spec-metadata.json',
});
```

### `fetchSpec()` — Fetch only

```typescript
import { fetchSpec } from 'camunda-schema-bundler';

const { specDir, entryPath, fetched } = await fetchSpec({
  ref: 'main',
  outputDir: 'external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2',
  skipIfExists: true, // skip if already fetched
});
```

### `detectUpstreamRef()` — Auto-detect git ref

```typescript
import { detectUpstreamRef } from 'camunda-schema-bundler';

const { ref, source, branch } = detectUpstreamRef();
// { ref: "stable/8.8", source: "branch-match", branch: "stable/8.8" }
```

### Utility exports

```typescript
import {
  hashDirectoryTree,     // SHA-256 hash of a directory for drift detection
  listFilesRecursive,    // List all files in a directory recursively
  findPathLocalLikeRefs, // Find surviving path-local $like refs in a spec
} from 'camunda-schema-bundler';
```

## Bundling Pipeline

1. **Fetch** (optional) — Sparse git clone of [camunda/camunda](https://github.com/camunda/camunda) to extract only the OpenAPI spec directory
2. **Bundle** — `SwaggerParser.bundle()` merges multi-file YAML into a single document
3. **Augment** — Scan all upstream YAML files and add any schemas missing from the bundle
4. **Normalize** — Rewrite path-local `$ref`s back to `#/components/schemas/...` using:
   - Signature matching (canonical JSON comparison against known component schemas)
   - `$like` → `LikeFilter` rewrite (handles both `$like` and `%24like` encoded forms)
   - Manual overrides for known tricky paths
   - Inline deduplication
   - `x-semantic-type` extension rewriting
5. **Promote** — Inline schemas that couldn't be matched to existing components are promoted to new named component schemas
6. **Fresh dedup** — Iterative pass (up to 10 rounds until convergence) that deduplicates newly-promoted schemas against each other and existing components using signature matching, including resolution through intermediate `$ref` chains
7. **Rewrite** — Decode URI-encoded internal refs (`%24like` → `$like`)
8. **Validate** — Fail-fast if any path-local `$like` refs survive (configurable with `--allow-like-refs`)
9. **Dereference** (optional, `--deref-path-local`) — Inline remaining path-local `$ref`s for strict generators
10. **Extract metadata** — Build the intermediate representation (semantic keys, unions, operations, etc.)

## Metadata IR

The metadata output captures domain-specific information from the OpenAPI spec that all SDK generators need:

### Semantic Keys

Schemas marked with `x-semantic-type` or `x-semantic-key` extensions, representing typed key/ID values:

```json
{
  "name": "ProcessInstanceKey",
  "semanticType": "ProcessInstanceKey",
  "category": "system-key",
  "composition": { "schemaKind": "allOf", "refs": ["LongKey"] },
  "constraints": { "pattern": "^-?[0-9]+$", "minLength": 1, "maxLength": 25 },
  "flags": { "semanticKey": true, "includesLongKeyRef": true }
}
```

### Unions

OneOf/anyOf structures representing discriminated or hybrid unions:

```json
{
  "name": "ResourceKey",
  "kind": "union-wrapper",
  "branches": [
    { "branchType": "ref", "ref": "ProcessInstanceKey" },
    { "branchType": "ref", "ref": "JobKey" }
  ]
}
```

### Eventually Consistent Operations

Operations marked with `x-eventually-consistent: true`:

```json
{
  "operationId": "searchProcessInstances",
  "path": "/process-instances/search",
  "method": "post",
  "tags": ["Process Instance"]
}
```

### Operation Summaries

Every operation with metadata about body shape, union variants, source file, and response shape:

```json
{
  "operationId": "createProcessInstance",
  "path": "/process-instances",
  "method": "post",
  "sourceFile": "process-instance/process-instance.yaml",
  "eventuallyConsistent": false,
  "hasRequestBody": true,
  "requestBodyUnion": false,
  "requestBodyContentTypes": ["application/json"],
  "requestBodySchemaRef": "CreateProcessInstanceRequest",
  "successStatus": 200,
  "successResponseSchemaRef": "CreateProcessInstanceResult",
  "vendorExtensions": { "x-ergonomic-helper": "createProcessInstanceFromBpmnFile" }
}
```

The `sourceFile`, `requestBodyContentTypes`, `requestBodySchemaRef`,
`successResponseSchemaRef`, `successStatus`, and `vendorExtensions` fields
were added in `spec-metadata.json` schemaVersion `2.0.0`. Together they
remove the need to read `endpoint-map.json` and join on `"METHOD /path"`.

## Per-SDK Configuration

| SDK | `--deref-path-local` | Notes |
|---|---|---|
| TypeScript (`@hey-api/openapi-ts`) | No | Handles path-local refs natively |
| C# (Microsoft.OpenApi) | **Yes** | Can't resolve `#/paths/...` refs |
| Python (`openapi-python-client`) | **Yes** | Benefits from fully resolved refs |

## Example

See the [example/](example/) folder for a minimal standalone app that fetches, bundles, and inspects the spec using both the library API and the CLI.

```bash
cd example
npm install
npm start  # `prestart` builds the parent package first
```

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0
