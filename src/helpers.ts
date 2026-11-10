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
 *
 * If an intermediate node along the path is itself a `$ref`, the resolver
 * follows it first and then continues resolving the remaining segments.
 * This handles cases where `SwaggerParser.bundle()` emits refs that point
 * through other refs (e.g. `#/paths/.../schema/oneOf/2` where `schema` is
 * `{ "$ref": "#/components/schemas/ResourceKey" }`).
 */
export function resolveInternalRef(
  root: Record<string, unknown>,
  ref: string
): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return undefined;

    // If the current node is itself a $ref, follow it first
    const obj = cur as Record<string, unknown>;
    if (
      typeof obj['$ref'] === 'string' &&
      (obj['$ref'] as string).startsWith('#/')
    ) {
      const followed = resolveInternalRef(root, obj['$ref'] as string);
      if (followed && typeof followed === 'object') {
        cur = followed;
      }
    }

    cur = (cur as Record<string, unknown>)[jsonPointerDecode(seg)];
  }
  return cur;
}

const COMPONENT_SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;
const COMPONENT_INTERIOR_SCHEMA_REF = /^#\/components\/schemas\/[^/]+\/./;

/** Keywords whose value is literal instance data, never an OpenAPI reference. */
const LITERAL_PAYLOAD_KEYS = new Set(['example', 'default', 'enum', 'const']);

/** Keys whose value is a map from user-chosen names to OpenAPI objects. */
const NAME_MAP_KEYS = new Set([
  'paths', 'schemas', 'properties', 'patternProperties', 'responses',
  'parameters', 'requestBodies', 'headers', 'content', 'encoding', 'links',
  'callbacks', 'securitySchemes', 'variables', 'examples',
]);

/**
 * `object`: an OpenAPI object or schema, whose keys are keywords.
 * `nameMap`: keys are user-chosen names, so keywords are not interpreted.
 * `exampleObject` / `linkObject`: objects with keys that hold literal data.
 */
type ObjectKind = 'object' | 'exampleObject' | 'linkObject';
type WalkKind = ObjectKind | 'nameMap';

/** Map entries that are not plain OpenAPI objects, keyed by the map's key. */
const MAP_ENTRY_KIND: Record<string, ObjectKind> = {
  examples: 'exampleObject',
  links: 'linkObject',
};

/** Keys holding literal values or runtime expressions, never OpenAPI objects. */
const LITERAL_KEYS_BY_KIND: Record<ObjectKind, ReadonlySet<string>> = {
  object: new Set(),
  exampleObject: new Set(['value']),
  linkObject: new Set(['parameters', 'requestBody']),
};

/**
 * True for a `$ref` that points inside a component schema rather than at one,
 * e.g. `#/components/schemas/Foo/allOf/0`.
 */
export function isComponentInteriorSchemaRef(ref: string): boolean {
  return COMPONENT_INTERIOR_SCHEMA_REF.test(ref);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * True for maps that also allow `x-` extensions beside their entries: the
 * Paths Object and an operation's Responses Object. In every other name map
 * (including `components.responses`), `x-` is a legal entry name.
 */
function isExtensibleMap(key: string, parentPointer: string): boolean {
  return key === 'paths' || (key === 'responses' && parentPointer !== '#/components');
}

/**
 * Retarget every `$ref` that points inside a component schema to the named
 * component it ultimately resolves to.
 *
 * `SwaggerParser.bundle()` emits such refs when it first meets a schema nested
 * inside another component (e.g. as an `allOf` member). Once dedup has turned
 * that nested copy into `{ $ref: '#/components/schemas/Base' }`, the interior
 * ref is a ref to a ref, which generators cannot follow. The target is followed
 * through any chain of bare (`$ref`-only) internal nodes, wherever they live; a
 * ref is only retargeted when the chain ends at an existing top-level component.
 *
 * Literal data is not an OpenAPI reference context, so a `$ref` key inside it
 * is neither rewritten nor reported: `example`, `default`, `enum`, `const`,
 * schema-level `examples` arrays, Example Object `value`s, Link Object
 * `parameters` and `requestBody`, and `x-` extensions. The same words are still
 * traversed where they name a map entry (a `default` response, a property
 * called `example`) or an operation's own `parameters` / `requestBody`.
 *
 * Refs that cannot be retargeted are left in place and returned, each with the
 * JSON Pointer of the node that holds it, so the caller can fail loudly.
 */
export function collapseComponentInteriorRefs(root: Record<string, unknown>): {
  collapsed: number;
  unresolved: string[];
} {
  const components = root['components'] as Record<string, unknown> | undefined;
  const schemas = (components?.['schemas'] ?? {}) as Record<string, unknown>;

  const resolveToComponent = (ref: string): string | undefined => {
    const visited = new Set<string>();
    let cur = ref;
    while (!COMPONENT_SCHEMA_REF.test(cur)) {
      if (!cur.startsWith('#/') || visited.has(cur)) return undefined;
      visited.add(cur);
      const target = resolveInternalRef(root, cur);
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        return undefined;
      }
      const keys = Object.keys(target);
      const next = (target as Record<string, unknown>)['$ref'];
      if (keys.length !== 1 || typeof next !== 'string') return undefined;
      cur = next;
    }
    const name = COMPONENT_SCHEMA_REF.exec(cur)?.[1];
    return name !== undefined && jsonPointerDecode(name) in schemas ? cur : undefined;
  };

  let collapsed = 0;
  const unresolved: string[] = [];
  const stack: {
    node: unknown;
    at: string;
    kind: WalkKind;
    entryKind?: ObjectKind;
    extensible?: boolean;
  }[] = [
    { node: root, at: '#', kind: 'object' },
  ];
  const seen = new Set<unknown>();
  while (stack.length) {
    const { node, at, kind, entryKind = 'object', extensible = false } = stack.pop()!;
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => stack.push({ node: v, at: `${at}/${i}`, kind: 'object' }));
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (kind === 'nameMap') {
      for (const [k, v] of Object.entries(obj)) {
        if (extensible && k.startsWith('x-')) continue;
        stack.push({ node: v, at: `${at}/${escapePointerSegment(k)}`, kind: entryKind });
      }
      continue;
    }
    const ref = obj['$ref'];
    if (typeof ref === 'string' && isComponentInteriorSchemaRef(ref)) {
      const target = resolveToComponent(ref);
      if (target) {
        obj['$ref'] = target;
        collapsed++;
      } else {
        unresolved.push(`${at} -> ${ref}`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref' || k.startsWith('x-') || LITERAL_PAYLOAD_KEYS.has(k)) continue;
      if (LITERAL_KEYS_BY_KIND[kind].has(k)) continue;
      // Schema-level `examples` is an array of literal instances.
      if (k === 'examples' && Array.isArray(v)) continue;
      const childAt = `${at}/${escapePointerSegment(k)}`;
      if (NAME_MAP_KEYS.has(k) && !Array.isArray(v)) {
        stack.push({
          node: v,
          at: childAt,
          kind: 'nameMap',
          entryKind: MAP_ENTRY_KIND[k] ?? 'object',
          extensible: isExtensibleMap(k, at),
        });
      } else {
        stack.push({ node: v, at: childAt, kind: 'object' });
      }
    }
  }
  unresolved.sort();
  return { collapsed, unresolved };
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
 * Deterministically sort every JSON Schema `required` array in-place.
 *
 * JSON Schema treats `required` as a set, so the order of elements has no
 * semantic meaning. Upstream OpenAPI generators (e.g. the Java/Jackson
 * pipeline that produces the camunda/camunda spec) serialize from unordered
 * collections, so the array order flips between otherwise-identical runs.
 *
 * Left unsorted, the bundled output oscillates on every regeneration even
 * when no schema content has actually changed, which causes perpetual,
 * content-free git merge conflicts in every downstream SDK repository that
 * commits the bundled spec (see camunda/camunda-schema-bundler#35).
 *
 * Sorting is semantically a no-op for `required` and gives a stable,
 * diffable output. We deliberately only normalize `required`: arrays like
 * `enum` are technically ordered, and reordering them could change
 * code-generator output (e.g. the first enum value used as a default).
 */
export function sortRequiredArrays(root: unknown): void {
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
    const req = obj['required'];
    if (Array.isArray(req) && req.every((x) => typeof x === 'string')) {
      (req as string[]).sort();
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
}

/**
 * Visit every `parameters` array reachable under `paths`, at both the
 * path-item level (`paths./foo.parameters`) and the operation level
 * (`paths./foo.get.parameters`).
 *
 * Path items nested elsewhere — `webhooks`, `components.pathItems`, and
 * operation `callbacks` — are not traversed. The bundled Camunda spec has
 * none; broaden this (and its callers) if that changes.
 *
 * The callback receives the array itself (mutable in place) and a
 * human-readable location for diagnostics.
 */
export function forEachParameterArray(
  root: Record<string, unknown>,
  visit: (params: unknown[], where: string) => void
): void {
  const paths = root['paths'];
  if (!paths || typeof paths !== 'object') return;
  for (const [apiPath, itemRaw] of Object.entries(
    paths as Record<string, unknown>
  )) {
    if (!itemRaw || typeof itemRaw !== 'object') continue;
    for (const [key, valueRaw] of Object.entries(
      itemRaw as Record<string, unknown>
    )) {
      if (key === 'parameters') {
        if (Array.isArray(valueRaw)) visit(valueRaw, apiPath);
        continue;
      }
      if (!valueRaw || typeof valueRaw !== 'object' || Array.isArray(valueRaw))
        continue;
      const params = (valueRaw as Record<string, unknown>)['parameters'];
      if (Array.isArray(params))
        visit(params, `${key.toUpperCase()} ${apiPath}`);
    }
  }
}

/**
 * Collect surviving path-local `$refs` inside `parameters` arrays, within the
 * traversal scope of {@link forEachParameterArray}.
 *
 * Should be empty after the inlining pass in `bundle()` (Step 3d); a non-empty
 * result means a ref could not be resolved, which produces a spec no generator
 * can consume.
 */
export function findPathLocalParameterRefs(
  root: Record<string, unknown>
): string[] {
  const found: string[] = [];
  forEachParameterArray(root, (params, where) => {
    for (const param of params) {
      if (!param || typeof param !== 'object') continue;
      const ref = (param as Record<string, unknown>)['$ref'];
      if (typeof ref === 'string' && ref.startsWith('#/paths/'))
        found.push(`${where} -> ${ref}`);
    }
  });
  return found;
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
