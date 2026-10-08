#!/usr/bin/env bash
# Build, ad-hoc sign, and verify the macOS binaries. Must run on macOS.
#
# `bun build --compile` appends the app bundle to a signed Bun runtime, which
# invalidates that signature. macOS kills (SIGKILL, exit 137) a binary whose
# signature doesn't match its contents, and Linux has no `codesign` to fix it.
# v0.77.0/v0.78.0 were cross-compiled on Linux and are killed on launch on
# macOS 27. release.yml ships what this script builds, and test.yml runs it on
# every PR, so a signing regression fails CI instead of `brew upgrade`.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-darwin.sh must run on macOS (needs codesign)" >&2
  exit 1
fi

for target in darwin-arm64 darwin-x64; do
  out="npm/releases-${target}/releases"
  bun build --compile src/index.ts --outfile "$out" --target="bun-${target}"
  chmod +x "$out"
  codesign --force --sign - "$out"
  codesign --verify --strict --verbose=2 "$out"
done

# Smoke-run the native build the way Homebrew's install does. A bad signature
# fails here instead of on a user's machine.
native="npm/releases-darwin-$(uname -m | sed 's/x86_64/x64/')/releases"
"$native" --version
"$native" completion bash | grep -q "complete -F _releases releases"
echo "darwin binaries signed and verified"
