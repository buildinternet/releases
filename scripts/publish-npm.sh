#!/usr/bin/env bash
set -euo pipefail

# Build and publish @buildinternet/releases to npm
#
# Usage:
#   ./scripts/publish-npm.sh          # dry run (default)
#   ./scripts/publish-npm.sh --publish # actually publish to npm
#
# Auth: Requires NPM_PUBLISHING_TOKEN in .env (or environment). npm dropped
# TOTP enrollment (Sep 2024) but `npm publish` still demands OTP for passkey
# accounts. A granular access token with "Bypass 2FA" is the workaround.
# See: https://github.com/orgs/community/discussions/181802

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM_DIR="$ROOT/npm"
DRY_RUN=true
NPMRC="$NPM_DIR/.npmrc"

if [[ "${1:-}" == "--publish" ]]; then
  DRY_RUN=false
fi

# Token auth (bypasses 2FA/passkey requirement)
if [[ -z "${NPM_PUBLISHING_TOKEN:-}" ]]; then
  # Try sourcing from .env
  if [[ -f "$ROOT/.env" ]]; then
    source "$ROOT/.env"
  fi
fi

if [[ -n "${NPM_PUBLISHING_TOKEN:-}" ]]; then
  echo "//registry.npmjs.org/:_authToken=${NPM_PUBLISHING_TOKEN}" > "$NPMRC"
  NPM_AUTH="--userconfig $NPMRC"
  trap "rm -f '$NPMRC'" EXIT
else
  NPM_AUTH=""
  echo "Warning: NPM_PUBLISHING_TOKEN not set. Publish will use interactive auth (may require OTP)."
fi

VERSION=$(node -p "require('$ROOT/package.json').version")
echo "Version: $VERSION"

# Sync version across all npm packages
for pkg in releases releases-darwin-arm64 releases-darwin-x64 releases-linux-x64 releases-linux-arm64; do
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$NPM_DIR/$pkg/package.json', 'utf8'));
    p.version = '$VERSION';
    if (p.optionalDependencies) {
      for (const k of Object.keys(p.optionalDependencies)) {
        p.optionalDependencies[k] = '$VERSION';
      }
    }
    fs.writeFileSync('$NPM_DIR/$pkg/package.json', JSON.stringify(p, null, 2) + '\n');
  "
done

echo "Building binaries..."

# macOS arm64 (native on Apple Silicon)
bun build --compile "$ROOT/src/index.ts" --outfile "$NPM_DIR/releases-darwin-arm64/releases"

# macOS x64
bun build --compile "$ROOT/src/index.ts" --outfile "$NPM_DIR/releases-darwin-x64/releases" \
  --target=bun-darwin-x64

# Linux x64
bun build --compile "$ROOT/src/index.ts" --outfile "$NPM_DIR/releases-linux-x64/releases" \
  --target=bun-linux-x64

# Linux arm64
bun build --compile "$ROOT/src/index.ts" --outfile "$NPM_DIR/releases-linux-arm64/releases" \
  --target=bun-linux-arm64

echo ""
echo "Binary sizes:"
for pkg in releases-darwin-arm64 releases-darwin-x64 releases-linux-x64 releases-linux-arm64; do
  size=$(du -sh "$NPM_DIR/$pkg/releases" | cut -f1)
  echo "  $pkg: $size"
done

# Publish platform packages first, then the main package
PACKAGES=(
  releases-darwin-arm64
  releases-darwin-x64
  releases-linux-x64
  releases-linux-arm64
  releases
)

echo ""
if $DRY_RUN; then
  echo "Dry run — would publish:"
  for pkg in "${PACKAGES[@]}"; do
    echo "  @buildinternet/$pkg@$VERSION"
  done
  echo ""
  echo "Run with --publish to actually publish."
else
  for pkg in "${PACKAGES[@]}"; do
    echo "Publishing @buildinternet/$pkg@$VERSION..."
    npm publish "$NPM_DIR/$pkg" --access public $NPM_AUTH
  done
  echo ""
  echo "Published @buildinternet/releases@$VERSION"
fi
