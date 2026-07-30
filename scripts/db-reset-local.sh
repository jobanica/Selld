#!/usr/bin/env bash
# Rebuild a bare Postgres container from the migrations, for iterating on schema
# work without the full Supabase stack.
#
#   scripts/db-reset-local.sh [container-name]
#
# `supabase db reset` is the normal path; this exists for the tighter loop of
# "edit a migration, apply it from scratch, run the SQL tests" against just the
# database image CI uses.
set -euo pipefail

CONTAINER="${1:-selld-pg}"
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

if ! docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
  echo "Container '$CONTAINER' is not accepting connections." >&2
  exit 1
fi

# `pg_isready` goes true before the image finishes installing extension files, so
# a migration applied immediately after it can fail on a missing extension. Gate on
# something that actually proves the instance is usable.
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" psql -U postgres -qtAc \
       "select 1 from pg_available_extensions where name = 'pg_trgm'" | grep -q 1; then
    break
  fi
  sleep 1
done

echo "Dropping everything the migrations own…"
# -i is required: without it docker does not forward stdin, so the heredoc is
# silently discarded and the reset does nothing.
docker exec -i "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
drop schema if exists public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;

-- Objects the migrations create outside `public`.
drop trigger if exists on_auth_user_created on auth.users;
truncate auth.users cascade;
drop function if exists extensions.unaccent_safe(text) cascade;

drop policy if exists "Tenant public assets are readable by anyone" on storage.objects;
drop policy if exists "Admins upload their tenant's assets" on storage.objects;
drop policy if exists "Admins replace their tenant's assets" on storage.objects;
drop policy if exists "Admins delete their tenant's assets" on storage.objects;
delete from storage.buckets where id = 'tenant-public';
SQL

echo "Applying migrations…"
for file in supabase/migrations/*.sql; do
  printf '  %-52s' "$(basename "$file")"
  # NOTE: reading from stdin, psql prefixes diagnostics with "psql:<stdin>:LINE:",
  # so an anchored '^ERROR' pattern silently matches nothing and every migration
  # looks like it passed. Match ERROR anywhere on the line.
  output=$(docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file" 2>&1 \
    | grep -v 'already exists, skipping' || true)
  if grep -q 'ERROR' <<<"$output"; then
    echo 'FAILED'
    grep -B1 -A4 'ERROR' <<<"$output" | head -14
    exit 1
  fi
  echo 'ok'
done

echo "Seeding PSGC…"
SUPABASE_DB_URL="$DB_URL" pnpm psgc:seed 2>&1 | tr '\r' '\n' | grep -E 'barangays  |Done'

echo
echo "Ready: $DB_URL"
