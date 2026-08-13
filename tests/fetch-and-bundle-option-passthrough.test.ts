import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `fetchAndBundle()` is a thin wrapper that re-declares every `bundle()` option
 * on its own options type and hand-forwards them. A newly added option is easy
 * to declare and forget to forward, which produces an option that type-checks,
 * documents itself, and silently does nothing — the exact defect this guard
 * exists to catch (`allowPathLocalParameterRefs` shipped that way).
 *
 * Class-scoped on purpose: it asserts the property for EVERY shared option, not
 * for the one that happened to regress.
 */

const srcDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src'
);

/** Body of `export interface <name> { ... }`, brace-matched. */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`unterminated interface ${name}`);
}

/** Top-level member names of an interface body (comments ignored). */
function memberNames(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^ {2}(\w+)\??:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Keys of the object literal passed to `bundle({ ... })`. */
function forwardedKeys(source: string): string[] {
  const start = source.indexOf('bundle({');
  if (start === -1) throw new Error('bundle({ ... }) call not found');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0)
      return source
        .slice(start, i + 1)
        .split('\n')
        .map((line) => /^ {4}(\w+):/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name));
  }
  throw new Error('unterminated bundle({ ... }) call');
}

describe('fetchAndBundle option pass-through', () => {
  it('forwards every option it shares with bundle()', () => {
    const types = fs.readFileSync(path.join(srcDir, 'types.ts'), 'utf8');
    const wrapper = fs.readFileSync(
      path.join(srcDir, 'fetch-and-bundle.ts'),
      'utf8'
    );

    const bundleOptions = new Set(
      memberNames(interfaceBody(types, 'BundleOptions'))
    );
    const shared = memberNames(
      interfaceBody(types, 'FetchAndBundleOptions')
    ).filter((name) => bundleOptions.has(name));
    const forwarded = new Set(forwardedKeys(wrapper));

    // Guards the guard: a broken extractor would vacuously pass.
    expect(shared.length).toBeGreaterThan(5);

    const dropped = shared.filter((name) => !forwarded.has(name));
    expect(
      dropped,
      `FetchAndBundleOptions declares these but fetchAndBundle() never passes ` +
        `them to bundle(), so setting them does nothing: ${dropped.join(', ')}`
    ).toEqual([]);
  });
});
