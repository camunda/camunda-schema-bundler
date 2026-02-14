/**
 * Utility helpers for spec bundling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Recursively list all files under a directory (sorted for determinism).
 */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  out.sort();
  return out;
}

/**
 * Compute a deterministic SHA-256 hash of an entire directory tree.
 * Hashes file relative paths + contents for drift detection.
 */
export function hashDirectoryTree(rootDir: string): string {
  const hash = createHash('sha256');
  for (const abs of listFilesRecursive(rootDir)) {
    hash.update(path.relative(rootDir, abs));
    hash.update(fs.readFileSync(abs));
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Decode a URI-encoded internal $ref (e.g. `#/paths/.../%24like` → `#/paths/.../$like`).
 */
export function normalizeInternalRef(ref: string): string {
  if (!ref.startsWith('#') || !ref.includes('%')) return ref;
  try {
    return '#' + decodeURIComponent(ref.slice(1));
  } catch {
    return ref;
  }
}

/**
 * Walk the tree and decode all URI-encoded internal $refs.
 */
export function rewriteInternalRefs(root: unknown): void {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (typeof obj['$ref'] === 'string') {
      obj['$ref'] = normalizeInternalRef(obj['$ref'] as string);
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
}

/**
 * Rewrite external file $refs (e.g. `./foo.yaml#/components/schemas/Bar`) to local form.
 */
export function rewriteExternalRefsToLocal(root: unknown): void {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'] as string;
      if (
        ref.includes('#/components/schemas/') &&
        (ref.includes('.yaml') || ref.includes('.yml'))
      ) {
        const name = ref.split('#/components/schemas/').pop();
        if (name) obj['$ref'] = `#/components/schemas/${name}`;
      }
    }
    for (const k of Object.keys(obj)) {
      if (k !== '$ref') stack.push(obj[k]);
    }
  }
}

/**
 * Decode a JSON Pointer segment.
 */
export function jsonPointerDecode(segment: string): string {
  return decodeURIComponent(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Resolve an internal $ref (e.g. `#/components/schemas/Foo`) against a root document.
 */
export function resolveInternalRef(
  root: Record<string, unknown>,
  ref: string
): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[jsonPointerDecode(seg)];
  }
  return cur;
}

/**
 * Deep-sort object keys recursively for canonical comparison.
 */
export function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (typeof obj === 'object' && obj !== null) {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((obj as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return obj;
}

/**
 * Produce a canonical JSON string (sorted keys) for signature matching.
 */
export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

/**
 * Strip metadata fields (description, title) from a schema tree for structural matching.
 * This allows matching schemas that are structurally identical but differ in documentation.
 */
function stripMetadata(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripMetadata);
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'description' || key === 'title') continue;
      result[key] = stripMetadata(val);
    }
    return result;
  }
  return obj;
}

/**
 * Produce a canonical JSON string ignoring metadata (description, title)
 * for structural signature matching.
 */
export function structuralStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(stripMetadata(obj)));
}

/**
 * Count path-local $like refs in the bundled spec (should be 0 after normalization).
 */
export function findPathLocalLikeRefs(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj['$ref'] === 'string' &&
      (obj['$ref'] as string).startsWith('#/paths/') &&
      /\/properties\/(\$like|%24like)$/.test(obj['$ref'] as string)
    ) {
      count++;
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
  return count;
}
