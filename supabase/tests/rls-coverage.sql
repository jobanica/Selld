-- ===========================================================================
-- RLS penetration test, per table
-- ===========================================================================
-- Phase 20. Every other suite in this directory checks the tables somebody
-- thought to write an assertion for. This one checks the tables nobody did.
--
-- The failure mode it exists for is not a bug in a policy — it is a table added
-- in a hurry, six phases from now, by someone who forgot the two lines at the
-- bottom of the "Writing a tenant-scoped table" section of CLAUDE.md. That table
-- would pass the tenancy suite by not being mentioned in it. Here it fails by
-- existing.
--
-- Three properties are checked for every table in `public`:
--
--   1. RLS is enabled *and* forced. `ENABLE` alone leaves the table owner
--      exempt, and the definer functions in this schema run as the owner.
--   2. Either it has a policy, or it is on the no-policy list below — the tables
--      that hold a secret or an authority and are reachable only through a
--      `SECURITY DEFINER` function.
--   3. No client role holds a privilege the table's design says it must not.
--
-- The lists are the point. Adding a table to one is a deliberate act with a
-- reason next to it; the default for a new table is to fail.
begin;

create schema if not exists rlstests;

create or replace function rlstests.fail(what text, rows text[])
returns void language plpgsql as $$
begin
  if array_length(rows, 1) > 0 then
    raise exception E'%:\n  - %', what, array_to_string(rows, E'\n  - ');
  end if;
  raise notice '  ok  %', what;
end;
$$;

-- ---------------------------------------------------------------------------
-- The two deliberate exception lists
-- ---------------------------------------------------------------------------
create table rlstests.no_policy (tablename text primary key, why text not null);

insert into rlstests.no_policy values
  ('social_accounts',
   'holds a page access token: it can post as the seller, read their inbox and message their customers'),
  ('marketplace_connections',
   'holds a marketplace token, the same class of secret'),
  ('buyer_risk_signals',
   'pools delivery history across tenants; the only reader is a definer that subtracts the callers own numbers'),
  ('buyer_risk_phones',
   'the hash to tenant map, which is the one thing that could re-identify the pool'),
  ('short_link_clicks',
   'a per-click log with timestamps is a browsing history and nothing in the product needs one row of it'),
  ('platform_admins',
   'holds authority rather than a secret: a table a client can insert into is a table that grants its own membership'),
  ('rate_limit_counters',
   'a counter a client can read tells it how close it is to the limit, and one it can write is not a limit'),
  ('platform_secrets',
   'one row of platform keys; the only readers are definers that never return them'),
  ('buyer_risk_contributions',
   'the per-tenant half of the cross-tenant pool: a reader could subtract it back out and re-identify'),
  ('marketplace_stock_queue',
   'a work queue claimed by the sync worker under skip locked; nothing client-side has a reason to see it');

/**
 * Tables that have RLS enabled but deliberately not forced.
 *
 * Every one is platform reference data with no tenant in it, and every one is
 * *written by an owner-run loader*: the PSGC seeder, or the migration that
 * inserts the vocabulary. FORCE would subject `postgres` to the read-only policy
 * these tables carry, and `pnpm psgc:seed` would fail on 42,046 barangays with a
 * permission error that reads like a bug in the seeder.
 *
 * The property FORCE protects — an owner-run `SECURITY DEFINER` function
 * bypassing a tenant policy — does not exist here, because there is no tenant
 * policy to bypass. A row of these tables is the same row for every store.
 */
create table rlstests.no_force (tablename text primary key, why text not null);

insert into rlstests.no_force values
  ('psgc_regions',        'PSA reference data, loaded by an owner-run seeder'),
  ('psgc_provinces',      'PSA reference data, loaded by an owner-run seeder'),
  ('psgc_cities',         'PSA reference data, loaded by an owner-run seeder'),
  ('psgc_barangays',      'PSA reference data, 42,046 rows, loaded by an owner-run seeder'),
  ('shipment_status_map', 'courier status vocabulary, seeded by migration'),
  ('order_transitions',   'the allowed fulfilment moves, seeded by migration'),
  ('message_tags',        'Facebook message tags, seeded by migration');

-- Tables with no `tenant_id`, and why that is correct rather than an oversight.
create table rlstests.no_tenant (tablename text primary key, why text not null);

insert into rlstests.no_tenant values
  ('psgc_regions',    'PSA reference data, identical for every store'),
  ('psgc_provinces',  'PSA reference data'),
  ('psgc_cities',     'PSA reference data'),
  ('psgc_barangays',  'PSA reference data'),
  ('profiles',        'a person, not a store; membership is in tenant_members'),
  ('tenants',         'is the store'),
  ('tenant_members',  'the membership itself; scoped by tenant_id but that IS the tenant'),
  ('shipment_status_map', 'courier status vocabulary, identical for every store'),
  ('buyer_risk_signals',  'deliberately spans tenants; see phase 12'),
  ('buyer_risk_phones',   'deliberately spans tenants'),
  ('buyer_risk_salt',     'one platform secret'),
  ('plans',           'the catalogue; a reseller-owned plan is scoped by reseller_id'),
  ('resellers',       'owns tenants rather than belonging to one'),
  ('reseller_members','belongs to a reseller'),
  ('platform_admins', 'Selld staff belong to no store'),
  ('announcements',   'from Selld or from a reseller, to many stores'),
  ('breach_log',      'a breach can be one stores or the platforms'),
  ('rate_limit_counters', 'counts requests, not rows belonging to anybody'),
  ('webhook_events',  'records deliveries we could not always attribute; tenant_id is nullable on purpose'),
  ('order_transitions','the allowed fulfilment moves, identical for every store'),
  ('message_tags',     'Facebook message tags, identical for every store'),
  ('platform_secrets', 'one row of platform keys, belonging to no store'),
  ('short_link_clicks',
   'reachable only through its parent link, which is tenant scoped; the row deliberately carries nothing else'),
  ('schema_migrations', 'supabase bookkeeping');

-- ---------------------------------------------------------------------------
-- 1. RLS is on, and forced
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== RLS coverage'

do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(c.relname || ' (rowsecurity=' || c.relrowsecurity::text || ')'
                            order by c.relname), '{}')
    into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname <> 'schema_migrations'
    and not c.relrowsecurity;

  perform rlstests.fail('every table in public has RLS enabled', bad);
end;
$$;

do $$
declare bad text[] := '{}';
begin
  -- FORCE matters more than it looks. Without it the table *owner* is exempt,
  -- and every `SECURITY DEFINER` function in this schema runs as the owner — so
  -- a table with ENABLE alone has its policies bypassed by exactly the code
  -- paths most worth constraining.
  select coalesce(array_agg(c.relname order by c.relname), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname <> 'schema_migrations'
    and c.relrowsecurity and not c.relforcerowsecurity
    and not exists (select 1 from rlstests.no_force x where x.tablename = c.relname);

  perform rlstests.fail(
    'and FORCE, so the owner is not exempt — except the reference tables an owner-run seeder writes',
    bad);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A policy, or a documented reason for having none
-- ---------------------------------------------------------------------------
do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname <> 'schema_migrations'
    and not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = c.relname)
    and not exists (select 1 from rlstests.no_policy x where x.tablename = c.relname);

  perform rlstests.fail(
    'every table has a policy, or is on the list of tables that deliberately have none', bad);
end;
$$;

do $$
declare bad text[] := '{}';
begin
  -- The list has to stay honest in the other direction too. A table that grew a
  -- policy after being listed as having none is a table whose comment is now a
  -- lie, and the next reader will believe the comment.
  select coalesce(array_agg(x.tablename order by x.tablename), '{}') into bad
  from rlstests.no_policy x
  where exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = x.tablename);

  perform rlstests.fail('and nothing on that list has quietly grown one', bad);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Hard rule 1: a tenant-scoped table has tenant_id NOT NULL
-- ---------------------------------------------------------------------------
do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from rlstests.no_tenant x where x.tablename = c.relname)
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'tenant_id'
        and a.attnum > 0 and not a.attisdropped and a.attnotnull);

  perform rlstests.fail(
    'every table has tenant_id NOT NULL, or a reason on the no-tenant list', bad);
end;
$$;

/**
 * A child of a tenant-scoped parent must be *unrepresentable* across tenants.
 *
 * CLAUDE.md's rule, checked mechanically: give the parent `unique (tenant_id, id)`
 * and have the child reference `(tenant_id, parent_id)`. Postgres then refuses a
 * cross-tenant child at the constraint level, which is strictly stronger than a
 * policy — it holds inside a `SECURITY DEFINER` function, where policies do not.
 *
 * So: every foreign key from a tenant-scoped table to another tenant-scoped
 * table has to carry `tenant_id`. A plain `parent_id` FK is a row that can be
 * pointed at somebody else's parent, and the only thing standing in the way is
 * whichever function happened to write it.
 */
do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(
           child.relname || '.' || con.conname || ' -> ' || parent.relname
           order by child.relname, con.conname), '{}')
    into bad
  from pg_constraint con
    join pg_class child  on child.oid  = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace n  on n.oid = child.relnamespace
  where con.contype = 'f'
    and n.nspname = 'public'
    -- Both sides carry a tenant.
    and exists (select 1 from pg_attribute a where a.attrelid = child.oid
                  and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
    and exists (select 1 from pg_attribute a where a.attrelid = parent.oid
                  and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
    -- ...and the key does not.
    and not exists (
      select 1 from unnest(con.conkey) as k
        join pg_attribute a on a.attrelid = child.oid and a.attnum = k
      where a.attname = 'tenant_id');

  perform rlstests.fail(
    'every FK between two tenant-scoped tables carries tenant_id, so a cross-tenant child cannot exist',
    bad);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The secrets, one by one
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Encrypted credentials'

do $$
declare
  r record;
  bad text[] := '{}';
begin
  -- Every column in the schema that holds an encrypted credential, found by
  -- shape rather than by a list — a new provider added in phase 21 gets checked
  -- because of what it named its column, not because somebody remembered.
  for r in
    select c.relname as tbl, a.attname as col
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped
      and (a.attname like '%_encrypted' or a.attname like '%secret_key%'
           or a.attname like '%access_token%' or a.attname like '%callback_token%')
  loop
    if has_column_privilege('anon', ('public.' || r.tbl)::regclass, r.col, 'SELECT') then
      bad := bad || (r.tbl || '.' || r.col || ' readable by anon')::text;
    end if;
    if has_column_privilege('authenticated', ('public.' || r.tbl)::regclass, r.col, 'SELECT') then
      bad := bad || (r.tbl || '.' || r.col || ' readable by authenticated')::text;
    end if;
  end loop;

  perform rlstests.fail('no client role can select an encrypted credential column', bad);
end;
$$;

do $$
declare bad text[] := '{}';
begin
  -- And no *view* carries one out. `payment_accounts_safe` and its siblings
  -- exist precisely to derive facts from these columns without exposing them;
  -- a view that selects the column itself undoes all of it, silently, and would
  -- pass every check above because the check is on the table.
  select coalesce(array_agg(table_name || '.' || column_name || ' ' || data_type
                            order by table_name), '{}')
    into bad
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (select table_name from information_schema.views
                       where table_schema = 'public')
    and (column_name like '%_encrypted' or column_name like '%secret_key'
         or column_name like '%access_token' or column_name like '%callback_token')
    -- `has_secret_key boolean` is the *point* of a safe view: a fact derived from
    -- a column the caller cannot read. What must not appear is one that could
    -- carry the value, so the type is what disqualifies a column here, not the
    -- name — a rule keyed on the name alone would either fail on every safe view
    -- or be defeated by renaming the column.
    and data_type not in ('boolean');

  perform rlstests.fail('and no view carries one out', bad);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. anon holds nothing it was not deliberately given
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== What anon can reach'

create table rlstests.anon_readable (tablename text primary key, why text not null);
insert into rlstests.anon_readable values
  ('psgc_regions',   'the address picker on a public checkout form'),
  ('psgc_provinces', 'the address picker'),
  ('psgc_cities',    'the address picker'),
  ('psgc_barangays', 'the address picker');

do $$
declare bad text[] := '{}';
begin
  -- A buyer has no account, so `anon` is the storefront. Everything it needs
  -- goes through a `SECURITY DEFINER` function that validates a cart token or an
  -- order number first; a direct table grant is a way around all of that.
  select coalesce(array_agg(c.relname order by c.relname), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, 'SELECT')
    and not exists (select 1 from rlstests.anon_readable x where x.tablename = c.relname);

  perform rlstests.fail('anon can select only the PSGC reference tables', bad);
end;
$$;

do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(c.relname || ':' || w order by c.relname), '{}') into bad
  from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as w
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, w);

  perform rlstests.fail('and cannot write to any table at all', bad);
end;
$$;

\echo ''
\echo '=== RLS COVERAGE PASSED'
\echo ''

rollback;
