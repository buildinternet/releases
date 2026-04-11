#!/usr/bin/env bash
set -euo pipefail

# Bump the CLI version across all source files.
#
# Usage:
#   ./scripts/bump-version.sh patch   # 0.9.2 → 0.9.3
#   ./scripts/bump-version.sh minor   # 0.9.2 → 0.10.0
#   ./scripts/bump-version.sh major   # 0.9.2 → 1.0.0
#   ./scripts/bump-version.sh 1.2.3   # explicit version
#
# This updates CLI version references in the source tree. The npm/
# packages are synced automatically by the release workflow at build time.
# Non-CLI packages (web, workers) manage their own versions independently.

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

# Root package.json (CLI version of record)
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$ROOT/package.json"
echo "  ✓ package.json"

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
  git commit -m "chore: bump CLI version to $NEW_VERSION"
  git tag "cli@$NEW_VERSION"
  echo ""
  echo "Tagged cli@$NEW_VERSION. Push to trigger the release workflow:"
  echo "  git push origin main --tags"
else
  echo ""
  echo "Next steps:"
  echo "  1. Commit the version bump"
  echo "  2. git tag cli@$NEW_VERSION"
  echo "  3. git push origin main --tags    # triggers CI release"
  echo ""
  echo "Or re-run with --tag to commit and tag automatically:"
  echo "  $0 $BUMP --tag"
fi
