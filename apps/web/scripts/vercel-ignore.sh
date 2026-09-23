#!/usr/bin/env bash
# Vercel ignored-build-step for the web app.
# Exit 0 = skip build; exit 1 = proceed with build.
# Logic lives here so web/vercel.json's ignoreCommand stays under the 256-char schema limit.
set -u

if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "skip: non-production"
  exit 0
fi

# Shallow clones often lack the previous deploy SHA; fetch it so the diff can resolve.
git fetch origin "${VERCEL_GIT_PREVIOUS_SHA:-}" --depth=1 -q 2>/dev/null || true

# Repo-root :/ pathspecs stay correct regardless of Vercel Root Directory (usually web/).
if git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}" HEAD -- \
  :/web :/packages :/scripts :/bun.lock :/package.json; then
  echo "skip: no web-relevant changes"
  exit 0
fi

# Fail open: missing objects / empty previous SHA / any diff error → build.
echo "build: web inputs changed (or diff unavailable)"
exit 1
