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
function freshSignatureDedup(
  bundled: Record<string, unknown>,
  schemas: Record<string, unknown>
): number {
  // Build both exact and structural signature maps
  const exactSigMap = new Map<string, string>();
  const structSigMap = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    const obj = schema as Record<string, unknown>;
    if (obj['$ref']) continue;
    exactSigMap.set(canonicalStringify(schema), name);
    structSigMap.set(structuralStringify(schema), name);
  }

  let replaced = 0;
  const seen = new Set<unknown>();
  const componentValues = new Set(Object.values(schemas));

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (componentValues.has(node)) {
      if (!Array.isArray(node)) {
        for (const v of Object.values(node as Record<string, unknown>))
          walk(v);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;

    // Recurse first (post-order)
    for (const v of Object.values(obj)) walk(v);

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

    // Fall back to structural match (ignores description, title)
    if (!matchName) {
      const structSig = structuralStringify(obj);
      matchName = structSigMap.get(structSig);
    }

    if (matchName) {
      for (const k of Object.keys(obj)) delete obj[k];
      obj['$ref'] = `#/components/schemas/${matchName}`;
      replaced++;
    }
  }

  const paths = bundled['paths'];
  if (paths && typeof paths === 'object') {
    walk(paths);
  }

  return replaced;
}

/** Default manual overrides for known tricky path-local refs. */
const DEFAULT_MANUAL_OVERRIDES: Record<string, string> = {
  '#/paths/~1process-instances~1search/post/requestBody/content/application~1json/schema/properties/filter/allOf/0':
    'ProcessInstanceFilter',
  '#/paths/~1process-definitions~1%7BprocessDefinitionKey%7D~1statistics~1element-instances/post/requestBody/content/application~1json/schema/properties/filter/allOf/0/allOf/0':
    'BaseProcessInstanceFilterFields',
};

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
    dereferencedPathLocalRefCount: 0,
    pathLocalLikeRefCount: 0,
  };

  // ── Step 1: Bundle multi-file YAML into a single document ─────────────────

  const bundled = (await SwaggerParser.bundle(entryPath)) as Record<
    string,
    unknown
  >;

  // ── Step 2: Augment with missing schemas from all upstream YAML files ─────

  const components = ensureComponents(bundled);
  const schemas = components['schemas'] as Record<string, unknown>;

  const allFiles = listFilesRecursive(options.specDir);
  for (const file of allFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const doc = parseYaml(content) as Record<string, unknown> | null;
      const docComponents = doc?.['components'] as
        | Record<string, unknown>
        | undefined;
      const docSchemas = docComponents?.['schemas'] as
        | Record<string, unknown>
        | undefined;
      if (!docSchemas) continue;
      for (const [name, schema] of Object.entries(docSchemas)) {
        if (!schemas[name]) {
          const s = JSON.parse(JSON.stringify(schema));
          rewriteExternalRefsToLocal(s);
          schemas[name] = s;
          stats.augmentedSchemaCount++;
        }
      }
    } catch {
      // Skip unparseable files
    }
  }

  // ── Step 3: Normalize path-local $refs via signature matching ─────────────

  const componentValues = new Set(Object.values(schemas));
  const schemaSignatureMap = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    schemaSignatureMap.set(canonicalStringify(schema), name);
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
        if (matchingName) {
          obj['$ref'] = `#/components/schemas/${matchingName}`;
          return;
        }
      }
    }

    // Inline dedup: replace inline objects matching a component schema signature
    if (!obj['$ref']) {
      const sig = canonicalStringify(obj);
      const matchingName = schemaSignatureMap.get(sig);
      if (matchingName) {
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

  // ── Step 3c: Fresh dedup pass (runs after deref, see Step 4b) ──────────────

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

  for (let dedupPass = 1; dedupPass <= 10; dedupPass++) {
    const count = freshSignatureDedup(bundled, schemas);
    stats.freshDedupCount += count;
    if (count === 0) break;
    console.log(
      `[camunda-schema-bundler] Fresh dedup pass ${dedupPass}: replaced ${count} inline duplicates`
    );
  }

  // ── Step 5: Validate ──────────────────────────────────────────────────────

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
  const metadata = extractMetadata(bundled, schemas, specHash);

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

  return { spec: bundled, metadata, stats };
}

function ensureComponents(
  doc: Record<string, unknown>
): Record<string, unknown> {
  if (!doc['components']) doc['components'] = {};
  const components = doc['components'] as Record<string, unknown>;
  if (!components['schemas']) components['schemas'] = {};
  return components;
}
