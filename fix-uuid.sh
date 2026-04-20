#!/bin/bash

set -e

FILE="supabase/migrations/001_schema.sql"

echo "🔧 Fixing UUID strategy in $FILE ..."

# Backup safety
cp "$FILE" "$FILE.backup"

# Replace uuid_generate_v4 -> gen_random_uuid
sed -i 's/uuid_generate_v4()/gen_random_uuid()/g' "$FILE"

echo "✅ Replacement done"

echo "🔍 Checking remaining occurrences..."
grep -n "uuid_generate_v4" "$FILE" || echo "🎉 No legacy UUID functions left"

echo "🚀 Done. Ready to push migrations."
