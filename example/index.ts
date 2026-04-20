import { fetchAndBundle } from 'camunda-schema-bundler';
import type { EndpointMapEntry } from 'camunda-schema-bundler';
import fs from 'node:fs';

// Fetch the upstream Camunda REST API spec and bundle it in one call.
// By default this fetches from the `main` branch of camunda/camunda.
const result = await fetchAndBundle({
  outputDir: 'output/upstream',
  outputSpec: 'output/rest-api.bundle.json',
  outputMetadata: 'output/spec-metadata.json',
  outputEndpointMap: 'output/endpoint-map.json',
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n=== Bundle Stats ===');
console.log(`  Paths:     ${result.stats.pathCount}`);
console.log(`  Schemas:   ${result.stats.schemaCount}`);
console.log(`  Augmented: ${result.stats.augmentedSchemaCount}`);
console.log(`  Promoted:  ${result.stats.promotedInlineSchemaCount}`);
console.log(`  Deduped:   ${result.stats.freshDedupCount}`);

console.log('\n=== Metadata ===');
console.log(`  Semantic keys:           ${result.metadata.integrity.totalSemanticKeys}`);
console.log(`  Unions:                  ${result.metadata.integrity.totalUnions}`);
console.log(`  Operations:              ${result.metadata.integrity.totalOperations}`);
console.log(`  Eventually consistent:   ${result.metadata.integrity.totalEventuallyConsistent}`);

// ── Endpoint Map ─────────────────────────────────────────────────────────────

const endpointMap = result.endpointMap ?? [];
console.log(`\n=== Endpoint Map (${endpointMap.length} endpoints) ===`);

// Group endpoints by source file
const byFile = new Map<string, EndpointMapEntry[]>();
for (const entry of endpointMap) {
  const list = byFile.get(entry.sourceFile) ?? [];
  list.push(entry);
  byFile.set(entry.sourceFile, list);
}

// Print first 5 source files as a preview
const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [file, entries] of files.slice(0, 5)) {
  console.log(`\n  ${file} (${entries.length} endpoints):`);
  for (const e of entries.slice(0, 3)) {
    console.log(`    ${e.operation}`);
  }
  if (entries.length > 3) {
    console.log(`    ... and ${entries.length - 3} more`);
  }
}
if (files.length > 5) {
  console.log(`\n  ... and ${files.length - 5} more source files`);
}


// ── Output files ─────────────────────────────────────────────────────────────

console.log('\n=== Output Files ===');
for (const file of ['output/rest-api.bundle.json', 'output/spec-metadata.json', 'output/endpoint-map.json']) {
  if (fs.existsSync(file)) {
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ${file} (${size} KB)`);
  }
}

console.log('\nDone!');
