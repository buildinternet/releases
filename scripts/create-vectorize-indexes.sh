#!/usr/bin/env bash
#
# Provision the Cloudflare Vectorize indexes used by the semantic-search
# feature. Run ONCE per Cloudflare account (or after deleting an index).
#
# All three indexes are 512-dim cosine. The default embedding provider is
# Voyage `voyage-4-lite`, which defaults to 1024 dims but supports
# `output_dimension: 512` (Matryoshka-style truncation) so we request 512 to
# match these indexes. If you switch EMBEDDING_PROVIDER or to a model with
# incompatible dimensionality, you will need to recreate the indexes —
# Vectorize dimensions are immutable.
#
# Idempotent: existing indexes are reported and skipped instead of failing
# the whole script.
#
# Requirements:
#   - wrangler installed and authenticated (`wrangler whoami`)
#   - Account selected via CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc
#
# Usage:
#   ./scripts/create-vectorize-indexes.sh
#
set -euo pipefail

DIMENSIONS=512
METRIC=cosine

INDEXES=(
  "releases-v1"
  "entities-v1"
  "changelog-chunks-v1"
)

create_index() {
  local name="$1"
  echo ">> Creating Vectorize index: ${name} (dims=${DIMENSIONS}, metric=${METRIC})"
  if output=$(wrangler vectorize create "${name}" \
        --dimensions="${DIMENSIONS}" \
        --metric="${METRIC}" 2>&1); then
    echo "${output}"
  else
    if echo "${output}" | grep -qiE "already exists|vectorize_index_already_exists"; then
      echo "   (already exists — skipping)"
    else
      echo "${output}" >&2
      echo "!! Failed to create ${name}" >&2
      return 1
    fi
  fi
}

for idx in "${INDEXES[@]}"; do
  create_index "${idx}"
done

echo ""
echo "Done. VOYAGE_API_KEY is read from Cloudflare's Secrets Store —"
echo "confirm it exists in the dashboard (Workers → Secrets Store) and that"
echo "both releases-api and releases-mcp wrangler.jsonc bind it under"
echo "secrets_store_secrets."
