#!/usr/bin/env bash
# Build standalone binaries for all supported platforms using deno compile.
#
# Strips devDependencies before compiling to produce lighter binaries (~76MB vs ~167MB).
#
# Prerequisites: deno, node/npm (for tsc build)
# Usage: bash scripts/build-binaries.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$ROOT_DIR/bin"
DIST_ENTRY="$ROOT_DIR/dist/cli.js"

# Ensure TypeScript is compiled (needs devDependencies for tsc)
if [[ ! -f "$DIST_ENTRY" ]]; then
  echo "[build-binaries] Building TypeScript first..."
  npm run build --prefix "$ROOT_DIR"
fi

# Strip devDependencies so deno compile doesn't embed them
echo "[build-binaries] Stripping devDependencies for lighter binaries..."
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package.json.bak"
cp "$ROOT_DIR/package-lock.json" "$ROOT_DIR/package-lock.json.bak"
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('$ROOT_DIR/package.json','utf8'));
  delete pkg.devDependencies;
  require('fs').writeFileSync('$ROOT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
rm -rf "$ROOT_DIR/node_modules"
npm install --prefix "$ROOT_DIR" --ignore-scripts 2>/dev/null

cleanup() {
  echo "[build-binaries] Restoring package.json..."
  mv "$ROOT_DIR/package.json.bak" "$ROOT_DIR/package.json"
  mv "$ROOT_DIR/package-lock.json.bak" "$ROOT_DIR/package-lock.json"
}
trap cleanup EXIT

mkdir -p "$BIN_DIR"

TARGETS=(
  "x86_64-unknown-linux-gnu:camunda-schema-bundler-linux-x64"
  "aarch64-unknown-linux-gnu:camunda-schema-bundler-linux-arm64"
  "x86_64-apple-darwin:camunda-schema-bundler-darwin-x64"
  "aarch64-apple-darwin:camunda-schema-bundler-darwin-arm64"
  "x86_64-pc-windows-msvc:camunda-schema-bundler-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  output="${entry##*:}"
  echo "[build-binaries] Compiling for $target → bin/$output"
  deno compile \
    --allow-read --allow-write --allow-run --allow-env --allow-net \
    --target "$target" \
    --output "$BIN_DIR/$output" \
    "$DIST_ENTRY"
done

echo "[build-binaries] Done. Binaries in $BIN_DIR:"
ls -lh "$BIN_DIR"/camunda-schema-bundler-*
