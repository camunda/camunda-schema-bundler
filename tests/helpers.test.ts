import { describe, it, expect } from 'vitest';
import {
  normalizeInternalRef,
  canonicalStringify,
  sortKeys,
  rewriteExternalRefsToLocal,
  findPathLocalLikeRefs,
  jsonPointerDecode,
  resolveInternalRef,
} from '../src/helpers.js';

describe('normalizeInternalRef', () => {
  it('decodes URI-encoded internal refs', () => {
    expect(normalizeInternalRef('#/paths/foo/%24like')).toBe(
      '#/paths/foo/$like'
    );
  });

  it('leaves non-encoded refs unchanged', () => {
    expect(normalizeInternalRef('#/components/schemas/Foo')).toBe(
      '#/components/schemas/Foo'
    );
  });

  it('leaves non-internal refs unchanged', () => {
    expect(normalizeInternalRef('./foo.yaml#/components/schemas/Bar')).toBe(
      './foo.yaml#/components/schemas/Bar'
    );
  });

  it('handles double-encoded segments', () => {
    expect(normalizeInternalRef('#/paths/%257Bid%257D')).toBe(
      '#/paths/%7Bid%7D'
    );
  });
});

describe('canonicalStringify / sortKeys', () => {
  it('sorts object keys for consistent comparison', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('sorts nested keys', () => {
    const a = { b: { z: 1, a: 2 }, a: 1 };
    const b = { a: 1, b: { a: 2, z: 1 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('handles arrays', () => {
    expect(sortKeys([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
  });
});

describe('rewriteExternalRefsToLocal', () => {
  it('rewrites file-based refs to local component refs', () => {
    const obj = { $ref: './definitions.yaml#/components/schemas/Foo' };
    rewriteExternalRefsToLocal(obj);
    expect(obj.$ref).toBe('#/components/schemas/Foo');
  });

  it('leaves local refs unchanged', () => {
    const obj = { $ref: '#/components/schemas/Bar' };
    rewriteExternalRefsToLocal(obj);
    expect(obj.$ref).toBe('#/components/schemas/Bar');
  });

  it('handles nested objects', () => {
    const obj = {
      properties: {
        foo: { $ref: './types.yaml#/components/schemas/Baz' },
      },
    };
    rewriteExternalRefsToLocal(obj);
    expect(obj.properties.foo.$ref).toBe('#/components/schemas/Baz');
  });
});

describe('findPathLocalLikeRefs', () => {
  it('counts path-local $like refs', () => {
    const spec = {
      paths: {
        '/foo': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    properties: {
                      filter: {
                        properties: {
                          $like: { $ref: '#/paths/~1foo/post/requestBody/content/application~1json/schema/properties/filter/properties/$like' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(findPathLocalLikeRefs(spec)).toBe(1);
  });

  it('returns 0 for clean specs', () => {
    const spec = {
      paths: {},
      components: {
        schemas: {
          LikeFilter: { type: 'object' },
          Foo: { properties: { $like: { $ref: '#/components/schemas/LikeFilter' } } },
        },
      },
    };
    expect(findPathLocalLikeRefs(spec)).toBe(0);
  });
});

describe('jsonPointerDecode', () => {
  it('decodes ~1 to /', () => {
    expect(jsonPointerDecode('application~1json')).toBe('application/json');
  });

  it('decodes ~0 to ~', () => {
    expect(jsonPointerDecode('foo~0bar')).toBe('foo~bar');
  });

  it('decodes URI-encoded segments', () => {
    expect(jsonPointerDecode('%24like')).toBe('$like');
  });
});

describe('resolveInternalRef', () => {
  it('resolves component schema refs', () => {
    const root = {
      components: { schemas: { Foo: { type: 'string' } } },
    };
    expect(resolveInternalRef(root, '#/components/schemas/Foo')).toEqual({
      type: 'string',
    });
  });

  it('returns undefined for missing paths', () => {
    const root = { components: { schemas: {} } };
    expect(
      resolveInternalRef(root, '#/components/schemas/Missing')
    ).toBeUndefined();
  });

  it('handles encoded path segments', () => {
    const root = {
      paths: { '/foo': { post: { summary: 'test' } } },
    };
    expect(
      resolveInternalRef(root, '#/paths/~1foo/post/summary')
    ).toBe('test');
  });
});
