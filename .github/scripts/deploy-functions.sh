#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Deploying Edge Functions..."

for path in supabase/functions/*; do
  [ -d "$path" ] || continue

  fn=$(basename "$path")

  # ❌ skip internal / invalid folders
  if [[ "$fn" == _* ]]; then
    echo "⏭ skipping internal folder: $fn"
    continue
  fi

  # ❌ validation stricte Supabase naming rules
  if [[ ! "$fn" =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]]; then
    echo "⛔ invalid function name: $fn"
    continue
  fi

  echo "➡️ deploying $fn..."

  supabase functions deploy "$fn" \
    --project-ref "$SUPABASE_PROJECT_REF" \
    --no-verify-jwt

done

echo "✅ deployment complete"    --project-ref "$SUPABASE_PROJECT_REF" \
    --no-verify-jwt

done

echo "✅ All functions deployed successfully."
