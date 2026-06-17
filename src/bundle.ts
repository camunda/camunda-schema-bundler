/**
 * Core OpenAPI spec bundling logic.
 *
 * Takes a multi-file upstream OpenAPI spec directory and produces a single
 * normalized JSON document with all schemas as proper component refs.
 */
import fs from 'node:fs';
import path from 'node:path';

import SwaggerParser from '@apidevtools/swagger-parser';
import { parse as parseYaml } from 'yaml';

import {
  listFilesRecursive,
  hashDirectoryTree,
  normalizeInternalRef,
  rewriteInternalRefs,
  rewriteExternalRefsToLocal,
  resolveInternalRef,
  canonicalStringify,
  structuralStringify,
  findPathLocalLikeRefs,
  sortRequiredArrays,
} from './helpers.js';
import type { BundleOptions, BundleResult, BundleStats } from './types.js';
import { extractMetadata } from './metadata.js';

/**
 * Promote inline schemas inside component-level `oneOf`/`anyOf` compositions
 * to named component schemas. This ensures generators produce properly-named
 * types instead of auto-generating names from path context.
 *
 * Primary targets:
 * - `*FilterProperty` schemas have inline "Exact match" oneOf variants
 * - Any other component with inline oneOf/anyOf variants that have titles
 */
function promoteInlineSchemas(
  schemas: Record<string, unknown>,
  stats: BundleStats
): void {
  const newSchemas: Record<string, unknown> = {};

  for (const [schemaName, schemaValue] of Object.entries(schemas)) {
    if (!schemaValue || typeof schemaValue !== 'object') continue;
    const schema = schemaValue as Record<string, unknown>;

    for (const compositionKey of ['oneOf', 'anyOf'] as const) {
      const variants = schema[compositionKey];
      if (!Array.isArray(variants)) continue;

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i] as Record<string, unknown> | null;
        if (!variant || typeof variant !== 'object' || variant['$ref']) continue;

        // Only promote schemas that have enough structure to warrant a name
        const hasProperties = 'properties' in variant;
        const hasEnum = 'enum' in variant;
        const hasAllOf = 'allOf' in variant;
        if (!hasProperties && !hasEnum && !hasAllOf) continue;

        // Derive a proper name for the promoted schema
        let promotedName: string | undefined;

        // Pattern: *FilterProperty with inline "Exact match" variant
        if (schemaName.endsWith('FilterProperty')) {
          const title = variant['title'];
          if (typeof title === 'string' && /exact\s*match/i.test(title)) {
            const baseName = schemaName.replace(/FilterProperty$/, '');
            promotedName = `${baseName}ExactMatch`;
          }
        }

        // If no specific pattern matched, derive from schema name + title
        if (!promotedName) {
          const title = variant['title'];
          if (typeof title === 'string' && title.trim()) {
            const cleanTitle = title.replace(/\s+/g, '');
            promotedName = `${schemaName}${cleanTitle}`;
          }
        }

        if (!promotedName) continue;

        // Ensure unique name
        let finalName = promotedName;
        let counter = 1;
        while (schemas[finalName] || newSchemas[finalName]) {
          finalName = `${promotedName}${counter}`;
          counter++;
        }

        // Extract inline schema to a named component
        newSchemas[finalName] = JSON.parse(JSON.stringify(variant));

        // Replace inline with $ref
        for (const k of Object.keys(variant)) delete variant[k];
        variant['$ref'] = `#/components/schemas/${finalName}`;
      }
    }
  }

  // Merge promoted schemas into components
  const promotedCount = Object.keys(newSchemas).length;
  if (promotedCount > 0) {
    Object.assign(schemas, newSchemas);
    console.log(
      `[camunda-schema-bundler] Promoted ${promotedCount} inline schemas to named components`
    );
  }
}

/**
 * After normalization, do a fresh dedup pass to replace any inline schemas
 * in paths that are structurally identical to a named component schema.
 * This catches inlines that survived the initial signature matching because
 * normalization may have changed component schemas' internal structure.
 *
 * Uses two-pass matching: exact signature first, then structural (ignoring
 * description/title metadata) to catch dereferenced schemas that differ
 * only in metadata from their component counterparts.
 */
interface DedupResult {
  replaced: number;
  ambiguous: { path: string; candidates: string[] }[];
}

/**
 * Collect every `$ref` that appears inside a parsed YAML path-item subtree
 * and resolves to a `#/components/schemas/<NAME>` (same-file or cross-file).
 *
 * Records `(jsonPath in the bundled spec) -> NAME`, where `jsonPath` is
 * built in the same format `freshSignatureDedup`'s `walk()` emits — e.g.
 * `#/paths./mapping-rules.post.responses.201.content.application/json.schema`.
 *
 * Why this exists (camunda/camunda-schema-bundler#32): when
 * `SwaggerParser.bundle()` inlines a cross-file `$ref` whose target lives
 * in the root entry's `components/schemas`, the original ref *name* is
 * erased from the operation site. If the upstream spec defines several
 * named structural aliases for the same shape (e.g.
 * `MappingRuleCreate{,Update}Result`), `freshSignatureDedup` then sees
 * multiple candidates and the 2.4.0 fail-hard guard triggers — even
 * though the upstream YAML was unambiguous. Recording the original ref
 * name from the source YAML lets us recover that identity, deterministically,
 * with no risk of picking the wrong alias.
 */
function collectOriginalSchemaRefsFromPathItem(
  pathItem: unknown,
  apiPath: string,
  method: string,
  out: Map<string, string>
): void {
  // Walk the operation subtree, building a jsonPath that matches the
  // format `freshSignatureDedup.walk()` produces. Only `$ref` strings
  // whose target is a component schema are recorded; refs to responses,
  // parameters, etc. are ignored.
  const root = pathItem;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  const operation = (root as Record<string, unknown>)[method];
  if (!operation || typeof operation !== 'object') return;
  const opPathPrefix = `#/paths./${apiPath.replace(/^\//, '')}.${method}`;

  function visit(node: unknown, jsonPath: string): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], `${jsonPath}[${i}]`);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string') {
      // Match either a same-file ref (`#/components/schemas/X`) or a
      // cross-file ref whose fragment ends in `/components/schemas/X`.
      // The leading file portion (if any) is irrelevant — what matters
      // is the schema name at the end of the JSON pointer.
      const m = ref.match(/(?:^|#)\/components\/schemas\/([^\/]+)$/);
      if (m && !out.has(jsonPath)) {
        out.set(jsonPath, m[1]);
      }
      // Don't recurse into a `$ref` node — its siblings are typically
      // metadata, not schema content, and they don't contribute to the
      // post-bundle inline.
      return;
    }
    for (const [k, v] of Object.entries(obj)) visit(v, `${jsonPath}.${k}`);
  }

  visit(operation, opPathPrefix);
}

/**
 * Recursively walk a component schema and record every `$ref` that targets
 * another component schema, keyed by the json-path **relative to the schema
 * root** (matching the format `freshSignatureDedup.walk()` produces). Only
 * nested refs are recorded — refs at the root level (`relPath === ''`) are
 * skipped because they represent the component schema itself, not a child.
 *
 * Used to recover the original ref name for an ambiguous nested inline
 * whose enclosing path-level schema came from a `$ref` to this component.
 * (camunda/camunda-schema-bundler#32)
 */
function collectComponentInternalRefs(
  node: unknown,
  relPath: string,
  out: Map<string, string>
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectComponentInternalRefs(node[i], `${relPath}[${i}]`, out);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  const ref = obj['$ref'];
  if (typeof ref === 'string') {
    const m = ref.match(/(?:^|#)\/components\/schemas\/([^/]+)$/);
    if (m && relPath !== '') out.set(relPath, m[1]);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    collectComponentInternalRefs(v, `${relPath}.${k}`, out);
  }
}

/**
 * For an ambiguous inline at `jsonPath`, walk back up the path looking for
 * the longest prefix that has a recorded original ref name. If found and
 * the matched component has an internal ref at the suffix relative path,
 * return that nested ref name. Otherwise undefined.
 *
 * (camunda/camunda-schema-bundler#32)
 */
function lookupNestedOriginalRef(
  jsonPath: string,
  originalRefByJsonPath: Map<string, string>,
  componentInternalRefs: Map<string, Map<string, string>>
): string | undefined {
  // Iterate prefix boundaries from longest to shortest. Boundaries are at
  // `.` and `[` characters \u2014 the same separators `walk()` uses to build
  // the path.
  for (let i = jsonPath.length - 1; i > 0; i--) {
    const c = jsonPath[i];
    if (c !== '.' && c !== '[') continue;
    const prefix = jsonPath.slice(0, i);
    const componentName = originalRefByJsonPath.get(prefix);
    if (!componentName) continue;
    const internal = componentInternalRefs.get(componentName);
    if (!internal) continue;
    // The suffix is the relative path inside the component, starting at
    // the same separator (so `properties.sort.items` becomes `.properties.sort.items`).
    const suffix = jsonPath.slice(i);
    return internal.get(suffix);
  }
  return undefined;
}

/**
 * Pre-computed schema analysis data that is stable across dedup passes
 * (component schemas don't change during Step 4b). Computing this once
 * avoids redundant full traversals on each pass.
 */
interface SchemaAnalysis {
  exactSigMap: Map<string, string>;
  structSigMap: Map<string, string>;
  exactSigCandidates: Map<string, string[]>;
  structSigCandidates: Map<string, string[]>;
  reverseRefIndex: Map<string, { source: string; propPath: string }[]>;
  componentInternalRefs: Map<string, Map<string, string>>;
}

function analyzeSchemas(schemas: Record<string, unknown>): SchemaAnalysis {
  const AMBIGUOUS = '@@AMBIGUOUS@@';
  const exactSigMap = new Map<string, string>();
  const structSigMap = new Map<string, string>();
  const exactSigCandidates = new Map<string, string[]>();
  const structSigCandidates = new Map<string, string[]>();

  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    const obj = schema as Record<string, unknown>;
    if (obj['$ref']) continue;
    const exactSig = canonicalStringify(schema);
    if (exactSigMap.has(exactSig)) {
      exactSigMap.set(exactSig, AMBIGUOUS);
    } else {
      exactSigMap.set(exactSig, name);
    }
    if (!exactSigCandidates.has(exactSig)) exactSigCandidates.set(exactSig, []);
    exactSigCandidates.get(exactSig)!.push(name);

    const structSig = structuralStringify(schema);
    if (structSigMap.has(structSig)) {
      structSigMap.set(structSig, AMBIGUOUS);
    } else {
      structSigMap.set(structSig, name);
    }
    if (!structSigCandidates.has(structSig)) structSigCandidates.set(structSig, []);
    structSigCandidates.get(structSig)!.push(name);
  }

  const reverseRefIndex = new Map<string, { source: string; propPath: string }[]>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    collectRefs(schema as Record<string, unknown>, '', name, reverseRefIndex);
  }

  // Precompute per-component-schema internal $refs. These are stable across
  // dedup passes because component schemas are never mutated.
  const componentInternalRefs = new Map<string, Map<string, string>>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    const map = new Map<string, string>();
    collectComponentInternalRefs(schema, '', map);
    if (map.size > 0) componentInternalRefs.set(name, map);
  }

  return { exactSigMap, structSigMap, exactSigCandidates, structSigCandidates, reverseRefIndex, componentInternalRefs };
}

function freshSignatureDedup(
  bundled: Record<string, unknown>,
  schemas: Record<string, unknown>,
  analysis: SchemaAnalysis,
  originalRefByJsonPath: Map<string, string>
): DedupResult {
  const AMBIGUOUS = '@@AMBIGUOUS@@';
  const { exactSigMap, structSigMap, exactSigCandidates, structSigCandidates, reverseRefIndex, componentInternalRefs } = analysis;

  let replaced = 0;
  const ambiguous: { path: string; candidates: string[] }[] = [];
  const seen = new Set<unknown>();
  const componentValues = new Set(Object.values(schemas));

  // Parent tracking: map from child object → { parent object, key in parent }
  const parentMap = new Map<unknown, { parent: Record<string, unknown>; key: string }>();

  function buildParentMap(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') {
          // Use the containing key (already set by the parent object entry)
          // for consistent path format with collectRefs
          buildParentMap(item);
        }
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object') {
        parentMap.set(val, { parent: obj, key });
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object') {
              parentMap.set(item, { parent: obj, key });
              buildParentMap(item);
            }
          }
        } else {
          buildParentMap(val);
        }
      }
    }
  }

  function walk(node: unknown, jsonPath = ''): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (componentValues.has(node)) {
      if (!Array.isArray(node)) {
        for (const [k, v] of Object.entries(node as Record<string, unknown>))
          walk(v, `${jsonPath}.${k}`);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (let idx = 0; idx < (node as unknown[]).length; idx++)
        walk((node as unknown[])[idx], `${jsonPath}[${idx}]`);
      return;
    }

    const obj = node as Record<string, unknown>;

    // Recurse first (post-order)
    for (const [k, v] of Object.entries(obj)) walk(v, `${jsonPath}.${k}`);

    // Resolve surviving path-local $refs (e.g. `sort/items` shared between two
    // structurally-identical alias schemas) to their intended component using
    // the original-ref context recorded from the source YAML.
    //
    // Step-3 signature normalization can't recover these: `SwaggerParser`
    // dedupes the shared subtree into a path-local $ref, and the
    // snapshot-resolved inline has its own nested refs (e.g. `order` ->
    // `SortOrderEnum`) inlined, so its exact signature matches NO component.
    // Without `--deref-path-local` the ref then survives un-rewritten and
    // dangling (its JSON pointer walks through a `$ref` node), which makes
    // generators emit a bare `Object`. See camunda/camunda-schema-bundler#32.
    if (
      typeof obj['$ref'] === 'string' &&
      (obj['$ref'] as string).startsWith('#/paths/')
    ) {
      const name =
        originalRefByJsonPath.get(jsonPath) ??
        lookupNestedOriginalRef(
          jsonPath,
          originalRefByJsonPath,
          componentInternalRefs
        );
      if (name && schemas[name]) {
        for (const k of Object.keys(obj)) delete obj[k];
        obj['$ref'] = `#/components/schemas/${name}`;
        replaced++;
      }
      return;
    }

    if (obj['$ref']) return;

    const isSchemaLike =
      'properties' in obj ||
      'enum' in obj ||
      'allOf' in obj ||
      'oneOf' in obj ||
      'anyOf' in obj;
    if (!isSchemaLike) return;

    // Try exact match first
    const exactSig = canonicalStringify(obj);
    let matchName = exactSigMap.get(exactSig);
    if (matchName === AMBIGUOUS) matchName = undefined;

    // Fall back to structural match (ignores description, title)
    let structSig: string | undefined;
    if (!matchName) {
      structSig = structuralStringify(obj);
      matchName = structSigMap.get(structSig);
      if (matchName === AMBIGUOUS) matchName = undefined;
    }

    // Disambiguate via component-level $ref context when signature is ambiguous
    if (!matchName) {
      const candidates =
        exactSigCandidates.get(exactSig) ??
        structSigCandidates.get(structSig ?? structuralStringify(obj));
      if (candidates && candidates.length > 1) {
        matchName = disambiguateByContext(obj, candidates, parentMap, schemas, reverseRefIndex);
        // Fallback 1: if the upstream YAML's original `$ref` at this exact
        // jsonPath named one of the candidates, that name is authoritative.
        // The signature match guarantees the schema is structurally that
        // component; the recorded name resolves *which alias* it was.
        // See camunda/camunda-schema-bundler#32.
        if (!matchName) {
          const originalName = originalRefByJsonPath.get(jsonPath);
          if (originalName && candidates.includes(originalName)) {
            matchName = originalName;
          }
        }
        // Fallback 2: a nested inline whose enclosing path-level schema
        // was originally a `$ref` to component C. Walk back up jsonPath to
        // find the longest prefix that maps to a recorded original ref;
        // the suffix is the relative path inside that component schema.
        // The component's preserved internal refs (bundled.components.schemas)
        // tell us which alias the inline represents.
        if (!matchName) {
          const nestedName = lookupNestedOriginalRef(
            jsonPath,
            originalRefByJsonPath,
            componentInternalRefs
          );
          if (nestedName && candidates.includes(nestedName)) {
            matchName = nestedName;
          }
        }
        if (!matchName) {
          ambiguous.push({ path: jsonPath, candidates: [...candidates] });
        }
      }
    }

    if (matchName) {
      for (const k of Object.keys(obj)) delete obj[k];
      obj['$ref'] = `#/components/schemas/${matchName}`;
      replaced++;
    }
  }

  const paths = bundled['paths'];
  if (paths && typeof paths === 'object') {
    buildParentMap(paths);
    walk(paths, '#/paths');
  }

  return { replaced, ambiguous };
}

/**
 * Collect all $ref targets from a component schema, recording the property
 * path where each ref appears (e.g., "properties.sort.items").
 */
function collectRefs(
  node: Record<string, unknown>,
  currentPath: string,
  sourceName: string,
  index: Map<string, { source: string; propPath: string }[]>
): void {
  if (typeof node['$ref'] === 'string') {
    const ref = node['$ref'] as string;
    if (ref.startsWith('#/components/schemas/')) {
      const target = ref.replace('#/components/schemas/', '');
      if (!index.has(target)) index.set(target, []);
      index.get(target)!.push({ source: sourceName, propPath: currentPath });
    }
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (!val || typeof val !== 'object') continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object') {
          collectRefs(
            item as Record<string, unknown>,
            currentPath ? `${currentPath}.${key}` : key,
            sourceName,
            index
          );
        }
      }
    } else {
      collectRefs(
        val as Record<string, unknown>,
        currentPath ? `${currentPath}.${key}` : key,
        sourceName,
        index
      );
    }
  }
}

/**
 * Disambiguate an ambiguous inline schema by checking component-level context.
 *
 * Strategy: walk up the parent chain from the inline schema to find a containing
 * schema-like object, then check if any component schema has a $ref to one of
 * the ambiguous candidates at the same relative path AND partially matches
 * the container (ignoring the ambiguous field itself).
 *
 * Example: inline at `sort.items` → parent is the sort array → grandparent is
 * a request schema with `properties.sort`. If a component schema has
 * `properties.sort.items.$ref → ResourceVariableSearchQuerySortRequest` and
 * its structure (minus sort.items) matches the grandparent (minus sort.items),
 * we pick that candidate.
 */
function disambiguateByContext(
  inlineObj: Record<string, unknown>,
  candidates: string[],
  parentMap: Map<unknown, { parent: Record<string, unknown>; key: string }>,
  schemas: Record<string, unknown>,
  reverseRefIndex: Map<string, { source: string; propPath: string }[]>
): string | undefined {
  // Walk up the parent chain, collecting all schema-like ancestors as
  // potential containers. Don't stop at the first one — composition
  // wrappers (allOf/oneOf/anyOf items) look schema-like but are too
  // narrow to match the reverse-ref index. We try each candidate
  // from innermost to outermost.
  const pathSegments: string[] = [];
  let current: unknown = inlineObj;
  const containerCandidates: {
    schema: Record<string, unknown>;
    relPath: string;
  }[] = [];

  for (;;) {
    const parentInfo = parentMap.get(current);
    if (!parentInfo) break;
    pathSegments.unshift(parentInfo.key);
    current = parentInfo.parent;

    const ancestor = current as Record<string, unknown>;
    if (
      ancestor['properties'] ||
      ancestor['allOf'] ||
      ancestor['type'] === 'object'
    ) {
      containerCandidates.push({
        schema: ancestor,
        relPath: pathSegments.join('.'),
      });
    }
  }

  // Try each container candidate (innermost first)
  for (const { schema: containerSchema, relPath } of containerCandidates) {
    const relParts = relPath.split('.');
    const containerPartial = stripAtPath(containerSchema, relParts);

    const matchingCandidates: string[] = [];
    for (const candidate of candidates) {
      const refs = reverseRefIndex.get(candidate);
      if (!refs) continue;

      for (const { source, propPath } of refs) {
        if (propPath !== relPath) continue;

        const sourceSchema = schemas[source];
        if (!sourceSchema || typeof sourceSchema !== 'object') continue;
        const sourcePartial = stripAtPath(
          sourceSchema as Record<string, unknown>,
          relParts
        );
        if (
          structuralStringify(sourcePartial) ===
          structuralStringify(containerPartial)
        ) {
          matchingCandidates.push(candidate);
          break;
        }
      }
    }

    if (matchingCandidates.length === 1) {
      return matchingCandidates[0];
    }
  }

  return undefined;
}

/**
 * Create a deep copy of an object with the value at the given path removed.
 * Used to compare schemas while ignoring a specific field (the ambiguous one).
 *
 * When a path segment refers to an array-valued property (e.g. `allOf`),
 * the strip operation is applied to every element of the array.
 */
function stripAtPath(
  obj: Record<string, unknown>,
  pathParts: string[]
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  stripAtPathInPlace(copy, pathParts, 0);
  return copy;
}

function stripAtPathInPlace(
  node: Record<string, unknown>,
  pathParts: string[],
  depth: number
): void {
  if (depth >= pathParts.length) return;
  const part = pathParts[depth];
  const isLast = depth === pathParts.length - 1;
  const child = node[part];

  if (isLast) {
    delete node[part];
    return;
  }

  if (!child || typeof child !== 'object') return;

  // If the child is an array, descend into each element
  if (Array.isArray(child)) {
    for (const item of child) {
      if (item && typeof item === 'object') {
        stripAtPathInPlace(item as Record<string, unknown>, pathParts, depth + 1);
      }
    }
  } else {
    stripAtPathInPlace(child as Record<string, unknown>, pathParts, depth + 1);
  }
}

/** Default manual overrides for known tricky path-local refs. */
const DEFAULT_MANUAL_OVERRIDES: Record<string, string> = {
  '#/paths/~1process-instances~1search/post/requestBody/content/application~1json/schema/properties/filter/allOf/0':
    'ProcessInstanceFilter',
  '#/paths/~1process-definitions~1%7BprocessDefinitionKey%7D~1statistics~1element-instances/post/requestBody/content/application~1json/schema/properties/filter/allOf/0/allOf/0':
    'BaseProcessInstanceFilterFields',
};

/**
 * Detect whether a bundled OpenAPI document is a monolithic (single-file) spec.
 *
 * A spec is considered monolithic if the entry file contains no external file
 * $ref patterns (i.e., `$ref:` values pointing to `.yaml` or `.yml` files).
 * Pre-8.9 specs are always single self-contained files with no external deps.
 *
 * For the augmentation step (Step 2), we use this to decide whether to scan
 * sibling YAML files. Monolithic specs are already complete; scanning sibling
 * files risks pulling in unrelated schemas (e.g. rest-api-v1.yaml on pre-8.9
 * branches).
 */
function isMonolithicEntryFile(entryPath: string): boolean {
  try {
    const content = fs.readFileSync(entryPath, 'utf8');
    // Match $ref values that reference external .yaml/.yml files.
    // Pattern: $ref: (with optional quotes) followed by a relative path to a yaml file.
    // This checks specifically for $ref syntax rather than any occurrence of the string.
    return !(/\$ref\s*:\s*['"]?[^'"#\s]*\.ya?ml#/m).test(content);
  } catch {
    return false;
  }
}

/**
 * Bundle the multi-file OpenAPI spec into a single normalized JSON document.
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const entryFile = options.entryFile ?? 'rest-api.yaml';
  const entryPath = path.join(options.specDir, entryFile);
  const manualOverrides = {
    ...DEFAULT_MANUAL_OVERRIDES,
    ...options.manualOverrides,
  };

  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `Spec entry not found at ${entryPath}. Ensure the upstream spec has been fetched.`
    );
  }

  const stats: BundleStats = {
    pathCount: 0,
    schemaCount: 0,
    augmentedSchemaCount: 0,
    promotedInlineSchemaCount: 0,
    freshDedupCount: 0,
    ambiguousInlineCount: 0,
    dereferencedPathLocalRefCount: 0,
    inlinedParamResponseRefCount: 0,
    pathLocalLikeRefCount: 0,
  };

  // ── Step 1: Bundle multi-file YAML into a single document ─────────────────

  const isMonolithic = isMonolithicEntryFile(entryPath);
  if (isMonolithic) {
    console.log(
      `[camunda-schema-bundler] Detected monolithic spec (pre-8.9) at ${entryPath}`
    );
  }

  const bundled = (await SwaggerParser.bundle(entryPath)) as Record<
    string,
    unknown
  >;

  // ── Step 2: Augment schemas & build endpoint map in a single pass ─────────
  // Scan YAML files once: extract missing component schemas (multi-file only)
  // and collect path→source mappings for the endpoint map.
  // For monolithic specs, only the entry file is scanned (schema augmentation
  // is skipped — the file is already self-contained).

  const components = ensureComponents(bundled);
  const schemas = components['schemas'] as Record<string, unknown>;

  const HTTP_METHODS = new Set([
    'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace',
  ]);
  const endpointMap: Record<string, string> = {};
  // Per-operation source file map keyed by `${methodLower} ${path}` (e.g.
  // "get /process-instances"). Used to populate `OperationSummary.sourceFile`
  // in the metadata IR. See https://github.com/camunda/camunda-schema-bundler/issues/21
  const sourceFileByOp = new Map<string, string>();
  // Original schema-ref name index keyed by the bundled-spec jsonPath at
  // which the inline schema will appear post-bundle. Populated by scanning
  // each upstream YAML's path-item operations for `$ref` strings whose
  // target is a `#/components/schemas/<NAME>`. Consumed by
  // `freshSignatureDedup` to break structural-alias ambiguity without
  // resorting to sort-order picks. See camunda/camunda-schema-bundler#32.
  const originalRefByJsonPath = new Map<string, string>();
  const opsSeen = new Set<string>();
  // `bundled.paths` is constant for the whole run; resolve it once and
  // pre-compute the set of bundled (path, method) pairs so the per-file
  // inner loop is a cheap O(1) membership check.
  const bundledPaths =
    (bundled['paths'] as Record<string, unknown> | undefined) ?? {};
  const bundledOps = new Set<string>();
  for (const [apiPath, pathItem] of Object.entries(bundledPaths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const key of Object.keys(pathItem as Record<string, unknown>)) {
      if (HTTP_METHODS.has(key)) bundledOps.add(`${key} ${apiPath}`);
    }
  }

  const allFiles = isMonolithic
    ? [entryPath]
    : listFilesRecursive(options.specDir);

  for (const file of allFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const doc = parseYaml(content) as Record<string, unknown> | null;

      // Augment missing component schemas (multi-file only)
      if (!isMonolithic) {
        const docComponents = doc?.['components'] as
          | Record<string, unknown>
          | undefined;
        const docSchemas = docComponents?.['schemas'] as
          | Record<string, unknown>
          | undefined;
        if (docSchemas) {
          for (const [name, schema] of Object.entries(docSchemas)) {
            if (!schemas[name]) {
              const s = JSON.parse(JSON.stringify(schema));
              rewriteExternalRefsToLocal(s);
              schemas[name] = s;
              stats.augmentedSchemaCount++;
            }
          }
        }
      }

      // Collect endpoint map entries.
      // Only include operations that actually made it into the bundled spec
      // (tracked in `bundledOps`), so sidecar/unreferenced YAMLs in `specDir`
      // don't leak endpoints into the map.
      const docPaths = doc?.['paths'] as Record<string, unknown> | undefined;
      if (docPaths) {
        const relFile = path.relative(options.specDir, file).split(path.sep).join(path.posix.sep);
        for (const [apiPath, pathItem] of Object.entries(docPaths)) {
          if (!pathItem || typeof pathItem !== 'object') continue;
          const methods = Object.keys(pathItem as Record<string, unknown>)
            .filter(k => HTTP_METHODS.has(k) && bundledOps.has(`${k} ${apiPath}`));
          if (methods.length === 0) continue;
          for (const key of methods.sort()) {
            const op = `${key.toUpperCase()} ${apiPath}`;
            if (opsSeen.has(op)) continue;
            opsSeen.add(op);
            endpointMap[op] = relFile;
            sourceFileByOp.set(`${key} ${apiPath}`, relFile);
          }
          // Record original schema-ref names from this YAML's path items
          // for every method that made it into the bundled spec.
          // (camunda/camunda-schema-bundler#32)
          for (const key of methods) {
            collectOriginalSchemaRefsFromPathItem(
              pathItem,
              apiPath,
              key,
              originalRefByJsonPath
            );
          }
        }
      }
    } catch {
      // Skip unparseable files
    }
  }

  // Sort endpoint map by path first, then HTTP method
  const sortedEntries = Object.entries(endpointMap).sort((a, b) => {
    const [methodA, ...pathPartsA] = a[0].split(' ');
    const [methodB, ...pathPartsB] = b[0].split(' ');
    const pathA = pathPartsA.join(' ');
    const pathB = pathPartsB.join(' ');
    const byPath = pathA.localeCompare(pathB);
    if (byPath !== 0) return byPath;
    return methodA.localeCompare(methodB);
  });
  const sortedEndpointMap: Record<string, string> = Object.fromEntries(sortedEntries);

  // ── Step 2b: Normalize unordered-set fields for deterministic signatures ──
  //
  // JSON Schema treats `required` as a set, but upstream serializers (the
  // Java/Jackson pipeline behind camunda/camunda) emit it from unordered
  // collections, so the array order flips between otherwise-identical runs.
  //
  // This MUST run before any signature computation (Step 3 onwards uses
  // `canonicalStringify` / `structuralStringify`, both of which sort object
  // keys but preserve array order). Two schemas that differ only in
  // `required` order would otherwise produce different signatures, causing
  // dedup/ambiguity decisions to flip between runs even when no schema
  // content has actually changed. Normalizing here also guarantees the
  // bundled output and the derived metadata are byte-stable for
  // byte-identical input — see camunda/camunda-schema-bundler#35.
  sortRequiredArrays(bundled);

  // ── Step 3: Normalize path-local $refs via signature matching ─────────────

  const componentValues = new Set(Object.values(schemas));
  const AMBIGUOUS = '@@AMBIGUOUS@@';
  const schemaSignatureMap = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    const sig = canonicalStringify(schema);
    if (schemaSignatureMap.has(sig)) {
      // Multiple component schemas share the same signature — mark ambiguous
      schemaSignatureMap.set(sig, AMBIGUOUS);
    } else {
      schemaSignatureMap.set(sig, name);
    }
  }

  // Snapshot before normalization: resolveInternalRef reads from this
  // immutable copy so that inline dedup mutations on the live document
  // cannot destroy paths that later ref resolutions depend on.
  const preNormSnapshot = JSON.parse(JSON.stringify(bundled));

  const normSeen = new Set<unknown>();
  function safeNormalize(root: unknown): void {
    if (!root || typeof root !== 'object') return;
    if (normSeen.has(root)) return;
    normSeen.add(root);

    const obj = root as Record<string, unknown>;

    // Rewrite path-local $like refs → LikeFilter
    {
      const rawRef = obj['$ref'];
      const normalized =
        typeof rawRef === 'string' ? normalizeInternalRef(rawRef) : undefined;
      if (
        normalized &&
        normalized.startsWith('#/paths/') &&
        /\/properties\/\$like$/.test(normalized) &&
        schemas['LikeFilter']
      ) {
        obj['$ref'] = '#/components/schemas/LikeFilter';
        return;
      }
    }

    // Don't mutate top-level component schemas themselves
    if (componentValues.has(root)) {
      for (const v of Object.values(obj)) safeNormalize(v);
      return;
    }

    if (Array.isArray(root)) {
      (root as unknown[]).forEach((x) => safeNormalize(x));
      return;
    }

    // Post-order: normalize children first
    for (const v of Object.values(obj)) safeNormalize(v);

    // Rewrite path-local refs to component refs
    if (
      typeof obj['$ref'] === 'string' &&
      (obj['$ref'] as string).startsWith('#/paths/')
    ) {
      const resolved = resolveInternalRef(preNormSnapshot, obj['$ref'] as string);
      if (resolved && typeof resolved === 'object') {
        safeNormalize(resolved);

        const resolvedObj = resolved as Record<string, unknown>;
        if (
          typeof resolvedObj['$ref'] === 'string' &&
          (resolvedObj['$ref'] as string).startsWith('#/components/schemas/')
        ) {
          obj['$ref'] = resolvedObj['$ref'];
          return;
        }

        // Check manual overrides
        if (manualOverrides[obj['$ref'] as string]) {
          obj['$ref'] = `#/components/schemas/${manualOverrides[obj['$ref'] as string]}`;
          return;
        }

        // Signature matching
        const sig = canonicalStringify(resolved);
        const matchingName = schemaSignatureMap.get(sig);
        if (matchingName && matchingName !== AMBIGUOUS) {
          obj['$ref'] = `#/components/schemas/${matchingName}`;
          return;
        }
      }
    }

    // Inline dedup: replace inline objects matching a component schema signature
    if (!obj['$ref']) {
      const sig = canonicalStringify(obj);
      const matchingName = schemaSignatureMap.get(sig);
      if (matchingName && matchingName !== AMBIGUOUS) {
        for (const k of Object.keys(obj)) delete obj[k];
        obj['$ref'] = `#/components/schemas/${matchingName}`;
      }
    }

    // Rewrite x-semantic-type extension to component ref
    if (
      obj['x-semantic-type'] &&
      !obj['$ref'] &&
      schemas[obj['x-semantic-type'] as string]
    ) {
      const target = obj['x-semantic-type'] as string;
      for (const k of Object.keys(obj)) delete obj[k];
      obj['$ref'] = `#/components/schemas/${target}`;
    }
  }

  safeNormalize(bundled);
  rewriteInternalRefs(bundled);

  // ── Step 3b: Promote inline schemas to named components ───────────────────

  const prePromotionCount = Object.keys(schemas).length;
  promoteInlineSchemas(schemas, stats);
  stats.promotedInlineSchemaCount = Object.keys(schemas).length - prePromotionCount;

  // Post-normalization + promotion snapshot for dereferencing.
  // Using this instead of preNormSnapshot means dereferenced schemas will
  // have normalized $like refs and promoted ExactMatch $refs.
  const postNormSnapshot = JSON.parse(JSON.stringify(bundled));

  // ── Step 3c: Inline dangling path-local parameter & response $refs ─────────
  //
  // `SwaggerParser.bundle()` strips the `components.parameters` and
  // `components.responses` sections: it inlines the FIRST usage of a shared
  // parameter/response under `paths` and rewrites every OTHER usage to a
  // path-local `$ref` (e.g. `#/paths/~1files~1{fileKey}/get/parameters/0`,
  // `#/paths/~1info/get/responses/401`).
  //
  // Schema refs are recovered by Step 3, which rewrites them to
  // `#/components/schemas/...` because that section survives. Parameters and
  // responses have NO surviving component section to point at, so the
  // path-local ref is the only form left. Consumers that resolve only
  // `#/components/...` pointers (e.g. the api-test-generator
  // semantic-graph-extractor) cannot follow a `#/paths/...` pointer and
  // silently drop the parameter/response — so an operation that shared a path
  // key parameter loses it entirely.
  //
  // Resolve each such ref by inlining a deep copy of its target. This is
  // always-on, independent of `dereferencePathLocalRefs` (which inlines ALL
  // path-local refs — including schemas — and so defeats component dedup). It
  // is scoped to refs whose pointer terminates at a `parameters/<idx>` or
  // `responses/<status>` node, which are never schema refs, so schema dedup is
  // untouched.
  const PARAM_REF_RE = /\/parameters\/\d+$/;
  const RESPONSE_REF_RE = /\/responses\/[^/]+$/;
  function inlineParamAndResponseRef(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const ref = (value as Record<string, unknown>)['$ref'];
    if (typeof ref !== 'string') return undefined;
    const normalized = normalizeInternalRef(ref);
    if (!normalized.startsWith('#/paths/')) return undefined;
    if (!PARAM_REF_RE.test(normalized) && !RESPONSE_REF_RE.test(normalized)) {
      return undefined;
    }
    const resolved =
      resolveInternalRef(
        postNormSnapshot as Record<string, unknown>,
        normalized
      ) ??
      resolveInternalRef(preNormSnapshot as Record<string, unknown>, normalized);
    if (!resolved || typeof resolved !== 'object') {
      // No silent failure: a path-local parameter/response ref that cannot be
      // resolved would otherwise reach downstream consumers as a dropped field.
      throw new Error(
        `Unable to resolve path-local parameter/response $ref '${ref}'. ` +
          `The bundled spec would carry a dangling pointer that downstream ` +
          `generators silently drop.`
      );
    }
    stats.inlinedParamResponseRefCount += 1;
    return JSON.parse(JSON.stringify(resolved));
  }
  {
    const seen = new Set<unknown>();
    const stack: unknown[] = [bundled];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const inlined = inlineParamAndResponseRef(node[i]);
          if (inlined !== undefined) node[i] = inlined;
          stack.push(node[i]);
        }
      } else {
        const obj = node as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          const inlined = inlineParamAndResponseRef(obj[key]);
          if (inlined !== undefined) obj[key] = inlined;
          stack.push(obj[key]);
        }
      }
    }
  }

  // ── Step 3d: Fresh dedup pass (runs after deref, see Step 4b) ──────────────

  // ── Step 4: Optionally dereference remaining path-local $refs ─────────────

  if (options.dereferencePathLocalRefs) {
    for (let pass = 1; pass <= 20; pass++) {
      let dereferenced = 0;
      const seen = new Set<unknown>();
      const stack: unknown[] = [bundled];

      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);

        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) {
            const item = node[i] as Record<string, unknown> | null;
            if (
              item &&
              typeof item === 'object' &&
              typeof item['$ref'] === 'string' &&
              (item['$ref'] as string).startsWith('#/paths/')
            ) {
              // Prefer post-normalization source (normalized $like, promoted schemas);
              // fall back to pre-normalization if the path was removed during normalization
              const resolved =
                resolveInternalRef(
                  postNormSnapshot as Record<string, unknown>,
                  item['$ref'] as string
                ) ??
                resolveInternalRef(
                  preNormSnapshot as Record<string, unknown>,
                  item['$ref'] as string
                );
              if (resolved) {
                node[i] = JSON.parse(JSON.stringify(resolved));
                dereferenced++;
              }
            }
            stack.push(node[i]);
          }
        } else {
          const obj = node as Record<string, unknown>;
          for (const [key, val] of Object.entries(obj)) {
            if (!val || typeof val !== 'object') continue;
            const valObj = val as Record<string, unknown>;
            if (
              typeof valObj['$ref'] === 'string' &&
              (valObj['$ref'] as string).startsWith('#/paths/')
            ) {
              const resolved =
                resolveInternalRef(
                  postNormSnapshot as Record<string, unknown>,
                  valObj['$ref'] as string
                ) ??
                resolveInternalRef(
                  preNormSnapshot as Record<string, unknown>,
                  valObj['$ref'] as string
                );
              if (resolved) {
                obj[key] = JSON.parse(JSON.stringify(resolved));
                dereferenced++;
              }
            }
            stack.push(obj[key]);
          }
        }
      }

      stats.dereferencedPathLocalRefCount += dereferenced;
      if (dereferenced === 0) break;
    }
  }

  // ── Step 4b: Fresh dedup pass (iterative) ──────────────────────────────────
  // Run after dereferencing so we can catch inline schemas that were created
  // by expanding path-local $refs. Iterates until convergence: each pass
  // may replace inner schemas with $refs, changing parent signatures so that
  // subsequent passes can match them to component schemas.

  let lastAmbiguous: { path: string; candidates: string[] }[] = [];
  const schemaAnalysis = analyzeSchemas(schemas);
  for (let dedupPass = 1; dedupPass <= 10; dedupPass++) {
    const { replaced: count, ambiguous } = freshSignatureDedup(
      bundled,
      schemas,
      schemaAnalysis,
      originalRefByJsonPath
    );
    stats.freshDedupCount += count;
    lastAmbiguous = ambiguous;
    if (count === 0) break;
    console.log(
      `[camunda-schema-bundler] Fresh dedup pass ${dedupPass}: replaced ${count} inline duplicates`
    );
  }

  // ── Step 5: Validate ──────────────────────────────────────────────────────

  // Fail if any inline schemas remain that match multiple component schemas
  // but could not be disambiguated. These will cause generator failures
  // (wrong type selection or literal path-segment type names).
  stats.ambiguousInlineCount = lastAmbiguous.length;
  if (lastAmbiguous.length > 0 && !options.allowAmbiguousInlines) {
    const details = lastAmbiguous
      .map(
        (a) =>
          `  ${a.path}\n    candidates: ${a.candidates.join(', ')}`
      )
      .join('\n');
    throw new Error(
      `${lastAmbiguous.length} ambiguous inline schema(s) could not be resolved to a ` +
        `unique component schema. Generators will produce incorrect types.\n${details}\n\n` +
        `Fix: refactor these inline schemas into named component schemas or otherwise ` +
        `make them structurally distinct so they resolve to a single component candidate. ` +
        `Set allowAmbiguousInlines to bypass this validation if needed.`
    );
  }

  stats.pathLocalLikeRefCount = findPathLocalLikeRefs(bundled);
  if (stats.pathLocalLikeRefCount > 0 && !options.allowPathLocalLikeRefs) {
    throw new Error(
      `${stats.pathLocalLikeRefCount} path-local $like ref(s) survived normalization. ` +
        `This will cause generator failures. Set allowPathLocalLikeRefs to bypass.`
    );
  }

  const paths = bundled['paths'] as Record<string, unknown> | undefined;
  stats.pathCount = paths ? Object.keys(paths).length : 0;
  stats.schemaCount = Object.keys(schemas).length;

  // ── Step 6: Extract metadata IR ───────────────────────────────────────────

  const specHash = hashDirectoryTree(options.specDir);
  const metadata = extractMetadata(bundled, schemas, specHash, sourceFileByOp);

  // ── Step 6b: Read sibling semantic-kinds.json (camunda/camunda-schema-bundler#28) ──
  //
  // The upstream spec ships a sibling registry that declares the valid `kind`
  // values for `x-semantic-establishes` / `x-semantic-requires`. Read it
  // verbatim if present; older refs predating camunda/camunda#52322 don't ship
  // one, in which case `semanticKinds` is null and no output file is written.
  //
  // Read as a raw Buffer so the on-disk output is byte-identical to the source
  // (avoids any UTF-8 round-trip surprises like BOM handling). Decode only for
  // JSON.parse to populate the result.
  const semanticKindsPath = path.join(options.specDir, 'semantic-kinds.json');
  let semanticKindsBuffer: Buffer | null = null;
  let semanticKinds: unknown = null;
  if (fs.existsSync(semanticKindsPath)) {
    semanticKindsBuffer = fs.readFileSync(semanticKindsPath);
    semanticKinds = JSON.parse(semanticKindsBuffer.toString('utf8'));
  }

  // ── Step 7: Write outputs ─────────────────────────────────────────────────

  if (options.outputSpec) {
    const dir = path.dirname(options.outputSpec);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      options.outputSpec,
      JSON.stringify(bundled, null, 2) + '\n',
      'utf8'
    );
  }

  if (options.outputMetadata) {
    const dir = path.dirname(options.outputMetadata);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      options.outputMetadata,
      JSON.stringify(metadata, null, 2) + '\n',
      'utf8'
    );
  }

  if (options.outputEndpointMap) {
    stats.endpointMapDeprecated = true;
    console.warn(
      '[camunda-schema-bundler] WARNING: endpoint-map.json is deprecated and ' +
        'will be removed in 3.0.0. The same per-operation source file is now ' +
        'available as `sourceFile` on each entry in `spec-metadata.json`\'s ' +
        '`operations[]`. See https://github.com/camunda/camunda-schema-bundler/issues/21'
    );
    const dir = path.dirname(options.outputEndpointMap);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      options.outputEndpointMap,
      JSON.stringify(sortedEndpointMap, null, 2) + '\n',
      'utf8'
    );
  }

  if (options.outputSemanticKinds && semanticKindsBuffer !== null) {
    const dir = path.dirname(options.outputSemanticKinds);
    fs.mkdirSync(dir, { recursive: true });
    // Write the original bytes verbatim to preserve byte-identical parity
    // with the upstream file.
    fs.writeFileSync(options.outputSemanticKinds, semanticKindsBuffer);
  }

  return { spec: bundled, metadata, endpointMap: sortedEndpointMap, semanticKinds, stats };
}

function ensureComponents(
  doc: Record<string, unknown>
): Record<string, unknown> {
  if (!doc['components']) doc['components'] = {};
  const components = doc['components'] as Record<string, unknown>;
  if (!components['schemas']) components['schemas'] = {};
  return components;
}
