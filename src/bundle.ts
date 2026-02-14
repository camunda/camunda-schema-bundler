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
  findPathLocalLikeRefs,
} from './helpers.js';
import type { BundleOptions, BundleResult, BundleStats } from './types.js';
import { extractMetadata } from './metadata.js';

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
      const resolved = resolveInternalRef(bundled, obj['$ref'] as string);
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

  // Snapshot before normalization for resolving path-local refs during dereference
  const preNormSnapshot = JSON.parse(JSON.stringify(bundled));

  safeNormalize(bundled);
  rewriteInternalRefs(bundled);

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
              const resolved = resolveInternalRef(
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
              const resolved = resolveInternalRef(
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
