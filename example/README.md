# Example

A minimal example showing how to use `camunda-schema-bundler` to fetch, bundle, and inspect the Camunda REST API spec.

## Run

Install dependencies and start the example:

```sh
npm install
npm start
```

This will:

1. Fetch the upstream Camunda OpenAPI spec from `main`
2. Bundle it into a single normalized JSON file
3. Extract the metadata intermediate representation
4. Generate an endpoint map showing which source file each API path came from
5. Print a summary of the results

All output files are written to `output/`.

## CLI alternative

You can also run the bundler via CLI instead of the library API:

```sh
npm run start:cli
```

## Output files

| File | Description |
|---|---|
| `output/rest-api.bundle.json` | Single, normalized OpenAPI 3 JSON spec |
| `output/spec-metadata.json` | Metadata IR (semantic keys, unions, operations) |
| `output/endpoint-map.json` | Map of each API path → source YAML file |
| `output/upstream/` | Raw fetched upstream spec files |

## Expected output

```
=== Bundle Stats ===
  Paths:     140
  Schemas:   511
  Augmented: ...
  Promoted:  ...
  Deduped:   ...

=== Metadata ===
  Semantic keys:           ...
  Unions:                  ...
  Operations:              ...
  Eventually consistent:   ...

=== Endpoint Map (140 endpoints) ===

  process-instance.yaml (12 endpoints):
    GET, POST             /process-instances
    POST                  /process-instances/search
    ...

  ... and more source files

=== Output Files ===
  output/rest-api.bundle.json (1234.5 KB)
  output/spec-metadata.json (56.7 KB)
  output/endpoint-map.json (8.9 KB)

Done!
```
