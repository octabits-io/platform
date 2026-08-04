#!/usr/bin/env bash
# SPIKE (elysia-exit-option): run tsc --extendedDiagnostics on each variant.
# Usage: node generate.mjs && ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

TSC="$(cd ../.. && pwd)/node_modules/.bin/tsc"

for variant in elysia-eden hono-naive hono-mitigated; do
  echo "=== $variant ==="
  out=$(cd "out/$variant" && "$TSC" -p tsconfig.json --extendedDiagnostics 2>&1) || true
  errors=$(echo "$out" | grep -c "error TS" || true)
  echo "errors: $errors"
  echo "$out" | grep -E "^(Files|Types|Instantiations|Memory used|Check time|Total time):" || true
  if [ "$errors" != "0" ]; then echo "$out" | grep "error TS" | sort | uniq -c | sort -rn | head -5; fi
  echo
done
