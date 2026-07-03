#!/usr/bin/env bash
#
# Compare row counts in a Wrangler data-only D1 export with target baselines.
#
# Usage:
#   check-db-shrinkage.sh <dump.sql> <threshold-percent> <table=current> [...]
#
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <dump.sql> <threshold-percent> <table=current> [...]" >&2
  exit 2
fi

DUMP_FILE="$1"
THRESHOLD_PERCENT="$2"
shift 2

if [[ ! -r "${DUMP_FILE}" ]]; then
  echo "error: export dump is not readable: ${DUMP_FILE}" >&2
  exit 2
fi
if [[ ! "${THRESHOLD_PERCENT}" =~ ^[0-9]+$ ]] || ((THRESHOLD_PERCENT > 100)); then
  echo "error: shrinkage threshold must be an integer from 0 to 100" >&2
  exit 2
fi

failed=0
for baseline in "$@"; do
  table="${baseline%%=*}"
  current="${baseline#*=}"
  if [[ "${baseline}" != *=* ]] || [[ ! "${table}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || \
    [[ ! "${current}" =~ ^[0-9]+$ ]]; then
    echo "error: invalid table baseline '${baseline}' (expected table=current)" >&2
    exit 2
  fi

  exported=$(awk -v table="${table}" '
    $0 ~ "^INSERT INTO [`\"]?" table "[`\"]?([[:space:]]|\\()" { count++ }
    END { print count + 0 }
  ' "${DUMP_FILE}")

  if ((current == 0 || exported >= current)); then
    shrinkage="0.00"
  else
    shrinkage=$(awk -v current="${current}" -v exported="${exported}" \
      'BEGIN { printf "%.2f", ((current - exported) * 100) / current }')
  fi
  echo "   ${table}: current=${current} exported=${exported} shrinkage=${shrinkage}%"

  # Integer cross-multiplication keeps the decision exact. A shrinkage exactly
  # equal to the threshold is allowed; only a greater shrinkage aborts.
  if ((current > 0 && exported * 100 < current * (100 - THRESHOLD_PERCENT))); then
    echo "error: shrinkage guard aborted: ${table} would shrink from ${current} to ${exported} (${shrinkage}%; limit ${THRESHOLD_PERCENT}%)" >&2
    failed=1
  fi
done

exit "${failed}"
