#!/usr/bin/env bash
# Runs every supabase/tests/*.sql suite (or the ones named as arguments) against a schema-only copy of the local
# database, as described in docs/repository-ingestion.md ("Running the SQL suites in an isolated database").
# The main `postgres` database and its data are never touched. Requires the local Supabase stack (npm run db:start).
set -uo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_OneForAll}"
COPY_DB="ofa_rls_iso"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

suites=("$@")
if [ ${#suites[@]} -eq 0 ]; then
  suites=("$ROOT"/supabase/tests/*.sql)
fi

cleanup() { docker exec "$CONTAINER" dropdb -U postgres --if-exists "$COPY_DB" >/dev/null 2>&1; }
trap cleanup EXIT

cleanup
docker exec "$CONTAINER" pg_dump -U postgres -s -d postgres -f /tmp/ofa_schema.sql || exit 1
docker exec "$CONTAINER" createdb -U supabase_admin "$COPY_DB" || exit 1
docker exec "$CONTAINER" psql -U supabase_admin -d "$COPY_DB" -q -f /tmp/ofa_schema.sql >/dev/null 2>&1
docker exec "$CONTAINER" psql -U supabase_admin -d postgres -q -c "alter database $COPY_DB owner to postgres" || exit 1

pass=0
fail=0
failed=()
for suite in "${suites[@]}"; do
  name="$(basename "$suite")"
  if output="$(docker exec -i "$CONTAINER" psql -U postgres -d "$COPY_DB" -v ON_ERROR_STOP=1 -q < "$suite" 2>&1)"; then
    pass=$((pass + 1))
    echo "PASS $name"
  else
    fail=$((fail + 1))
    failed+=("$name")
    echo "FAIL $name"
    echo "$output" | grep -E "ERROR|DETAIL|CONTEXT" | head -5 | sed 's/^/    /'
  fi
done

echo "SQL suites: $pass passed, $fail failed (of $((pass + fail)))"
[ "$fail" -eq 0 ]
