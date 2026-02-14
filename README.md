# camunda-schema-bundler

Bundle the Camunda multi-file OpenAPI spec into a single normalized JSON file with schema normalization and metadata extraction (intermediate representation).

Used by the [TypeScript](https://github.com/camunda/orchestration-cluster-api-js), [C#](https://github.com/camunda/orchestration-cluster-api-csharp), and [Python](https://github.com/camunda/orchestration-cluster-api-python) Camunda SDKs to produce a clean, generator-ready OpenAPI spec from the upstream multi-file YAML source.

## Why?

The upstream Camunda REST API spec is split across many YAML files. When bundled naïvely (e.g. with `SwaggerParser.bundle()`), the result contains:

- **Path-local `$ref`s** (`#/paths/...`) that many generators can't handle
- **Missing component schemas** from files that SwaggerParser doesn't walk
- **URI-encoded refs** (`%24like` instead of `$like`) that confuse generators
- **Inline duplicates** of schemas that should be component refs

This utility solves all of these problems and produces two outputs:

1. **Bundled spec** (`rest-api.bundle.json`) — A single, clean OpenAPI 3 JSON file with all schemas as proper `#/components/schemas/...` refs
2. **Metadata IR** (`spec-metadata.json`) — A structured intermediate representation of domain-specific information extracted from the spec

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
# Bundle from a fetched upstream spec directory
camunda-schema-bundler \
  --spec-dir external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2 \
  --output-spec external-spec/bundled/rest-api.bundle.json \
  --output-metadata external-spec/bundled/spec-metadata.json

# For generators that can't handle path-local $refs (e.g. Microsoft.OpenApi for C#)
camunda-schema-bundler \
  --spec-dir external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2 \
  --output-spec external-spec/bundled/rest-api.bundle.json \
  --deref-path-local
```

### CLI Options

| Option | Description |
|---|---|
| `--spec-dir <path>` | Path to the upstream spec directory (required) |
| `--entry-file <name>` | Entry YAML file name (default: `rest-api.yaml`) |
| `--output-spec <path>` | Output path for the bundled JSON spec |
| `--output-metadata <path>` | Output path for the metadata IR JSON |
| `--deref-path-local` | Inline remaining path-local `$ref`s (needed for Microsoft.OpenApi) |
| `--allow-like-refs` | Don't fail on surviving path-local `$like` refs |

## Library API

```typescript
import { bundle } from 'camunda-schema-bundler';

const result = await bundle({
  specDir: 'external-spec/upstream/zeebe/gateway-protocol/src/main/proto/v2',
  outputSpec: 'external-spec/bundled/rest-api.bundle.json',
  outputMetadata: 'external-spec/bundled/spec-metadata.json',
  dereferencePathLocalRefs: false, // set true for C#
});

console.log(result.stats);
// { pathCount: 140, schemaCount: 465, augmentedSchemaCount: 465, ... }

console.log(result.metadata.integrity);
// { totalSemanticKeys: 33, totalUnions: 49, totalOperations: 168, totalEventuallyConsistent: 88 }
```

## Bundling Pipeline

1. **Bundle** — `SwaggerParser.bundle()` merges multi-file YAML into a single document
2. **Augment** — Scan all upstream YAML files and add any schemas missing from the bundle
3. **Normalize** — Rewrite path-local `$ref`s back to `#/components/schemas/...` using:
   - Signature matching (canonical JSON comparison against known component schemas)
   - `$like` → `LikeFilter` rewrite
   - Manual overrides for known tricky paths
   - Inline deduplication
   - `x-semantic-type` extension rewriting
4. **Rewrite** — Decode URI-encoded internal refs (`%24like` → `$like`)
5. **Validate** — Fail-fast if any path-local `$like` refs survive (configurable)
6. **Dereference** (optional) — Inline remaining path-local `$ref`s for strict generators
7. **Extract metadata** — Build the intermediate representation

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

Every operation with metadata about body shape and union variants:

```json
{
  "operationId": "createProcessInstance",
  "path": "/process-instances",
  "method": "post",
  "eventuallyConsistent": false,
  "hasRequestBody": true,
  "requestBodyUnion": false
}
```

## Per-SDK Configuration

| SDK | `--deref-path-local` | Notes |
|---|---|---|
| TypeScript (`@hey-api/openapi-ts`) | No | Handles path-local refs natively |
| C# (Microsoft.OpenApi) | **Yes** | Can't resolve `#/paths/...` refs |
| Python (`openapi-python-client`) | **Yes** | Benefits from fully resolved refs |

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0
