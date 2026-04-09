#!/usr/bin/env bash
set -euo pipefail

# Bump the CLI version across all source files.
#
# Usage:
#   ./scripts/bump-version.sh patch   # 0.9.0 → 0.9.1
#   ./scripts/bump-version.sh minor   # 0.9.0 → 0.10.0
#   ./scripts/bump-version.sh major   # 0.9.0 → 1.0.0
#   ./scripts/bump-version.sh 1.2.3   # explicit version
#
# This updates all version references in the source tree. The npm/
# packages are synced automatically by publish-npm.sh at build time.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CURRENT=$(node -p "require('$ROOT/package.json').version")

if [[ $# -lt 1 ]]; then
  echo "Current version: $CURRENT"
  echo ""
  echo "Usage: $0 <patch|minor|major|x.y.z>"
  exit 1
fi

BUMP="$1"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  *.*.*)  NEW_VERSION="$BUMP" ;;
  *)
    echo "Error: Invalid bump type '$BUMP'. Use patch, minor, major, or x.y.z" >&2
    exit 1
    ;;
esac

echo "Bumping version: $CURRENT → $NEW_VERSION"
echo ""

# Files to update (npm/ packages are handled by publish-npm.sh)
FILES=(
  "package.json"
  "web/package.json"
  "workers/discovery/package.json"
)

for file in "${FILES[@]}"; do
  filepath="$ROOT/$file"
  if [[ -f "$filepath" ]]; then
    sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$filepath"
    echo "  ✓ $file"
  else
    echo "  ✗ $file (not found)" >&2
  fi
done

# Source code version constants
sed -i '' "s/VERSION = \"$CURRENT\"/VERSION = \"$NEW_VERSION\"/" "$ROOT/src/cli/program.ts"
echo "  ✓ src/cli/program.ts"

sed -i '' "s/version: \"$CURRENT\"/version: \"$NEW_VERSION\"/" "$ROOT/src/mcp/server.ts"
echo "  ✓ src/mcp/server.ts"

# Homebrew formula
if [[ -f "$ROOT/homebrew/releases.rb" ]]; then
  sed -i '' "s/version \"$CURRENT\"/version \"$NEW_VERSION\"/" "$ROOT/homebrew/releases.rb"
  echo "  ✓ homebrew/releases.rb"
fi

echo ""
echo "Done. Version is now $NEW_VERSION."

# Optionally tag for CI release
if [[ "${2:-}" == "--tag" ]]; then
  git add -A
  git commit -m "chore: bump version to $NEW_VERSION"
  git tag "v$NEW_VERSION"
  echo ""
  echo "Tagged v$NEW_VERSION. Push to trigger the release workflow:"
  echo "  git push origin main --tags"
else
  echo ""
  echo "Next steps:"
  echo "  1. Commit the version bump"
  echo "  2. git tag v$NEW_VERSION"
  echo "  3. git push origin main --tags    # triggers CI release"
  echo ""
  echo "Or re-run with --tag to commit and tag automatically:"
  echo "  $0 $BUMP --tag"
fi
