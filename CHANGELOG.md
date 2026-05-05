# [2.2.0](https://github.com/camunda/camunda-schema-bundler/compare/v2.1.0...v2.2.0) (2026-05-05)


### Bug Fixes

* **metadata:** deep-clone vendorExtension object/array values ([82d2adf](https://github.com/camunda/camunda-schema-bundler/commit/82d2adf70250bdb8836316990ef9bd65c59fbd86)), closes [#27](https://github.com/camunda/camunda-schema-bundler/issues/27)
* **metadata:** resolve $ref for requestBody/responses; pick first $ref content entry ([e25989b](https://github.com/camunda/camunda-schema-bundler/commit/e25989bc9c57b4635daaf11c17a419f2327ed8f1))


### Features

* **metadata:** consolidate endpoint metadata into spec-metadata.json ([6312eaa](https://github.com/camunda/camunda-schema-bundler/commit/6312eaaba94886877281dd53192af9cc6400b66d)), closes [#21](https://github.com/camunda/camunda-schema-bundler/issues/21) [camunda/api-test-generator#131](https://github.com/camunda/api-test-generator/issues/131)

# [2.1.0](https://github.com/camunda/camunda-schema-bundler/compare/v2.0.0...v2.1.0) (2026-04-26)


### Features

* **fetch:** support fetching upstream spec by raw commit SHA ([446503c](https://github.com/camunda/camunda-schema-bundler/commit/446503c376837d09536f40916ef37b739b11080b))

# [2.0.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.7.0...v2.0.0) (2026-04-22)


* fix!: change endpointMap to Record<string, string> ([f55f85a](https://github.com/camunda/camunda-schema-bundler/commit/f55f85a52419bdc68d8a7e81aab125ee0058592b))


### Bug Fixes

* updated endpoint map tests ([da37036](https://github.com/camunda/camunda-schema-bundler/commit/da370362a849021a9ed39fe62ea70a1dc6b451f4))
* Updated endpoint-map struct ([d636e60](https://github.com/camunda/camunda-schema-bundler/commit/d636e60da83c681a1c763491ac395777c536d5cb))


### BREAKING CHANGES

* BundleResult.endpointMap is now Record<string, string>

# [1.7.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.6.1...v1.7.0) (2026-04-20)


### Bug Fixes

* added stray yaml checks ([c65b69d](https://github.com/camunda/camunda-schema-bundler/commit/c65b69def9c38d2bb6548957d3447442262a838e))
* address PR review — filter endpointMap to bundled paths and make field required ([8fe3886](https://github.com/camunda/camunda-schema-bundler/commit/8fe38860cabed8207eaa380e1d6722ff06a749d7))
* address PR review — make example runnable from a clean checkout ([2ad31c7](https://github.com/camunda/camunda-schema-bundler/commit/2ad31c7a6c44fe8fe0cbd3c834296813931499bf))
* Changed sort comparator, updated README.md and fixed test ([fc0a63b](https://github.com/camunda/camunda-schema-bundler/commit/fc0a63b338e3601cf940058a0b8c0ff98187bdf1))
* Fixed de-duplication flow, updated README.md and addded root to example/package.json ([fd113db](https://github.com/camunda/camunda-schema-bundler/commit/fd113db64bc05e83a9554eaec9d52c086ca71711))
* Made endpointMap field optional in BundleResult interface, updated example/README.md ([4f0755d](https://github.com/camunda/camunda-schema-bundler/commit/4f0755d748680ff47db3a3330cdfceda15d877ec))
* Removed redundant buildEndpointMap() and using path.posix now to be OS agnostic ([aa95829](https://github.com/camunda/camunda-schema-bundler/commit/aa9582992b1e2954d896e785bed6a6622cbd55b6))
* Updated example/README.md for better upstream output directory cloarification and update outputEndpointMap tests for graceful failure ([1a21bea](https://github.com/camunda/camunda-schema-bundler/commit/1a21bead26823fd8a42d7fca25357028ed64e208))


### Features

* Added mode for generating mapping between endpoint and source .yaml file ([c27ff0f](https://github.com/camunda/camunda-schema-bundler/commit/c27ff0f8865fae5476a1923c27d2fd150f5c3f49))


### Performance Improvements

* **bundle:** hoist bundledPaths/bundledOps out of per-file loop ([49a0194](https://github.com/camunda/camunda-schema-bundler/commit/49a0194bf55355bc5a18688e704c3ad1e207a3ce))

## [1.6.1](https://github.com/camunda/camunda-schema-bundler/compare/v1.6.0...v1.6.1) (2026-04-03)


### Bug Fixes

* remove accidentally committed .tmp-clone gitlink ([d15ff4f](https://github.com/camunda/camunda-schema-bundler/commit/d15ff4f245a9c96c0d9a69450246665d011ba60e))

# [1.6.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.5.0...v1.6.0) (2026-04-03)


### Features

* support pre-8.9 monolithic OpenAPI specifications ([ab40756](https://github.com/camunda/camunda-schema-bundler/commit/ab40756a9dd1b8f85f91fb743581fdd3914e8ef7))

# [1.5.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.4.0...v1.5.0) (2026-03-02)


### Features

* support x-semantic-provider ([abf754d](https://github.com/camunda/camunda-schema-bundler/commit/abf754d7f652c886e7a570964ec00682e1a40a70))

# [1.4.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.3.3...v1.4.0) (2026-03-02)


### Features

* support x-deprecated-enum-members. fixes [#1](https://github.com/camunda/camunda-schema-bundler/issues/1) ([3d6ed58](https://github.com/camunda/camunda-schema-bundler/commit/3d6ed58a9240b3a617814ef39d8b7aeed48837ee))

## [1.3.3](https://github.com/camunda/camunda-schema-bundler/compare/v1.3.2...v1.3.3) (2026-02-17)


### Bug Fixes

* fix deduplication leading to collapsed schemas ([5dc3c3b](https://github.com/camunda/camunda-schema-bundler/commit/5dc3c3b48a6226d9213bac6af1675d2c61f7450c))

## [1.3.2](https://github.com/camunda/camunda-schema-bundler/compare/v1.3.1...v1.3.2) (2026-02-17)


### Bug Fixes

* update README with latest instructions ([8bb4a37](https://github.com/camunda/camunda-schema-bundler/commit/8bb4a370ccade69bcac3ea610eaef7a0b9e4c8e9))

## [1.3.1](https://github.com/camunda/camunda-schema-bundler/compare/v1.3.0...v1.3.1) (2026-02-17)


### Bug Fixes

* force publish ([c453cca](https://github.com/camunda/camunda-schema-bundler/commit/c453cca33f05549e1dd8da2d21d3ddd06b83528e))

# [1.3.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.2.1...v1.3.0) (2026-02-17)


### Bug Fixes

* fix deduplication logic ([e14729f](https://github.com/camunda/camunda-schema-bundler/commit/e14729f5a50aea4cb5e12d7efda59041faac409a))


### Features

* add --version ([0607b87](https://github.com/camunda/camunda-schema-bundler/commit/0607b87b0d25df3dde6126efdd91e82460e94096))

## [1.2.2](https://github.com/camunda/camunda-schema-bundler/compare/v1.2.1...v1.2.2) (2026-02-17)


### Bug Fixes

* fix deduplication logic ([e14729f](https://github.com/camunda/camunda-schema-bundler/commit/e14729f5a50aea4cb5e12d7efda59041faac409a))

## [1.2.1](https://github.com/camunda/camunda-schema-bundler/compare/v1.2.0...v1.2.1) (2026-02-17)


### Bug Fixes

* deterministic schema output fix ([ca24f97](https://github.com/camunda/camunda-schema-bundler/commit/ca24f97bfc56b1bdf09e245d4477dc0115dabf4d))

# [1.2.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.1.2...v1.2.0) (2026-02-14)


### Features

* materialize inline schemas ([9b279b9](https://github.com/camunda/camunda-schema-bundler/commit/9b279b982f1a80a122a5700bf66ceedeee6276c2))

## [1.1.2](https://github.com/camunda/camunda-schema-bundler/compare/v1.1.1...v1.1.2) (2026-02-14)


### Bug Fixes

* support git refs correctly ([5b09fdc](https://github.com/camunda/camunda-schema-bundler/commit/5b09fdc7cf14bf27e5814bc60a80fcfde8a8169d))

## [1.1.1](https://github.com/camunda/camunda-schema-bundler/compare/v1.1.0...v1.1.1) (2026-02-14)


### Bug Fixes

* correctly handle oneOf containing tenantId ([e0b6f2c](https://github.com/camunda/camunda-schema-bundler/commit/e0b6f2c00ee23013610a2e880abbda452582653c))

# [1.1.0](https://github.com/camunda/camunda-schema-bundler/compare/v1.0.0...v1.1.0) (2026-02-14)


### Features

* **metadata:** enrich operation summaries with params, bodyOnly, unionRefs, tenantId ([e5ad40c](https://github.com/camunda/camunda-schema-bundler/commit/e5ad40c572395f24ad5e1c6090da7ccda3c784e8))

# 1.0.0 (2026-02-14)


### Bug Fixes

* disable npm provenance for private repo ([b5d2947](https://github.com/camunda/camunda-schema-bundler/commit/b5d2947af6bbb7c5a86a99641b651390968d4c85))


### Features

* add --auto-ref flag for automatic upstream branch detection ([4e43512](https://github.com/camunda/camunda-schema-bundler/commit/4e43512cd957df9835e02000df4b480c33b1c0f5))

# 1.0.0 (2026-02-14)


### Bug Fixes

* disable npm provenance for private repo ([b5d2947](https://github.com/camunda/camunda-schema-bundler/commit/b5d2947af6bbb7c5a86a99641b651390968d4c85))
