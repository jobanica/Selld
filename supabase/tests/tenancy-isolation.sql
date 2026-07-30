-- Phase 1 done-when: two tenants exist and neither can read a single row of the
-- other's data. This file proves it.
--
--   pnpm db:test          (against the local stack)
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenancy-isolation.sql
--
-- Runs inside a transaction that is ROLLED BACK at the end, so it is safe to run
-- repeatedly against a database that already has data and leaves nothing behind.
--
-- Impersonation works by setting the same GUCs Supabase's PostgREST sets
-- (`request.jwt.claim.sub` / `.email`, and the newer `request.jwt.claims` JSON)
-- and switching to the `authenticated` role — so these tests exercise the real
-- RLS path, not a simulation of it.
--
-- Any failure raises and aborts with a non-zero exit code.

\set ON_ERROR_STOP on
\timing off

begin;

create schema tests;

-- The assertion helpers are called while impersonating `authenticated` / `anon`,
-- so those roles need to reach them. Rolled back with everything else.
grant usage on schema tests to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Assertion helpers
-- ---------------------------------------------------------------------------
-- Assertions are counted so the run reports how much was actually checked,
-- rather than just "no errors".
create function tests.pass(p_message text)
returns void language plpgsql as $$
declare v_count int := coalesce(nullif(current_setting('tests.passed', true), '')::int, 0) + 1;
begin
  perform set_config('tests.passed', v_count::text, true);
  raise notice '  ok % %', lpad(v_count::text, 3), p_message;
end;
$$;

create function tests.ok(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'FAILED: %', p_message using errcode = 'triggered_action_exception';
  end if;
  perform tests.pass(p_message);
end;
$$;

create function tests.eq(p_actual anyelement, p_expected anyelement, p_message text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAILED: % (expected %, got %)', p_message, p_expected, p_actual
      using errcode = 'triggered_action_exception';
  end if;
  perform tests.pass(format('%s (= %s)', p_message, p_actual));
end;
$$;

-- Assert a statement is rejected, for WITH CHECK violations and RPC guards which
-- raise rather than quietly affecting zero rows.
--
-- Crucially this does NOT accept any error. A typo, missing column, or unknown
-- function would otherwise look identical to a working security guard, and the
-- test would pass for entirely the wrong reason. Only authorisation and
-- constraint failures count; anything that smells like a broken test re-raises.
create function tests.rejects(p_sql text, p_message text)
returns void language plpgsql as $$
declare
  -- 42601 syntax, 42703 undefined column, 42P01 undefined table,
  -- 42883 undefined function, 42P02 undefined parameter.
  c_test_bugs constant text[] := array['42601', '42703', '42P01', '42883', '42P02'];
begin
  begin
    execute p_sql;
  exception
    when triggered_action_exception then
      raise;
    when others then
      if sqlstate = any (c_test_bugs) then
        raise exception 'BROKEN TEST: % — statement failed with % (%), which is a test bug, not a security guard',
          p_message, sqlstate, sqlerrm
          using errcode = 'triggered_action_exception';
      end if;
      perform tests.pass(format('%s [%s]', p_message, sqlstate));
      return;
  end;
  raise exception 'FAILED: % (statement succeeded but should have been rejected)', p_message
    using errcode = 'triggered_action_exception';
end;
$$;

-- Count rows affected by a statement, for RLS-filtered UPDATE/DELETE which are
-- silently scoped to zero rows rather than erroring.
create function tests.affected(p_sql text)
returns bigint language plpgsql as $$
declare v_count bigint;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function tests.login(p_user uuid, p_email text)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.email', p_email, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user, 'email', p_email, 'role', 'authenticated')::text,
    true
  );
end;
$$;

-- Simulate the storefront/anonymous caller.
create function tests.logout()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Set the tenant header PostgREST would forward, to exercise current_tenant_id().
create function tests.set_tenant_header(p_tenant text)
returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-selld-tenant', p_tenant)::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Fixtures'

-- Start from an empty slate.
--
-- The suite assumes it owns the database: it asserts absolute counts ("Rhea can
-- read exactly 1 tenant"), which any pre-existing row breaks. That is fine in CI,
-- where the database is created for the run, but `pnpm seed:demo` also creates a
-- store called `rheas-finds` — so a developer who seeds the storefront and then
-- runs the security suite got a unique-violation on the fixture instead of a test
-- result.
--
-- Safe because everything here runs inside the transaction this file rolls back at
-- the end: the delete is undone along with the fixtures.
delete from public.tenants;
delete from auth.users;

-- Rhea (the avatar), Marlon (an unrelated seller), Jess (Rhea's packer),
-- and Nica (authenticated but belongs to no tenant at all).
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'rhea@example.ph',
     '{"full_name":"Rhea Santos","phone":"639171234567"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'marlon@example.ph',
     '{"full_name":"Marlon Cruz"}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 'jess@example.ph',
     '{"full_name":"Jess Reyes"}'::jsonb),
  ('44444444-4444-4444-4444-444444444444', 'nica@example.ph',
     '{"full_name":"Nica Lim"}'::jsonb);

do $$
begin
  perform tests.eq(
    (select count(*)::int from public.profiles
      where id in ('11111111-1111-1111-1111-111111111111',
                   '22222222-2222-2222-2222-222222222222',
                   '33333333-3333-3333-3333-333333333333',
                   '44444444-4444-4444-4444-444444444444')),
    4, 'auth trigger created a profile for every new user');

  perform tests.eq(
    (select phone from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
    '+639171234567', 'trigger normalised 639… to +639… on the profile');
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenant creation
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Tenant creation'

set local role authenticated;

select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
select public.create_tenant('Rhea''s Finds', 'rheas-finds');
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
select public.create_tenant('Marlon Kicks', 'marlon-kicks');

reset role;

-- Stash the ids in a table so later DO blocks can read them. Deliberately avoids
-- psql meta-commands so this file also runs through a plain driver (see
-- scripts/db-test.ts, which has no psql fallback for them).
create table tests.ids as
select
  (select id from public.tenants where slug = 'rheas-finds')  as rhea_tenant,
  (select id from public.tenants where slug = 'marlon-kicks') as marlon_tenant,
  '11111111-1111-1111-1111-111111111111'::uuid as rhea,
  '22222222-2222-2222-2222-222222222222'::uuid as marlon,
  '33333333-3333-3333-3333-333333333333'::uuid as jess,
  '44444444-4444-4444-4444-444444444444'::uuid as nica;

grant select on tests.ids to authenticated, anon;

do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.ok(i.rhea_tenant is not null, 'Rhea''s tenant was created');
  perform tests.ok(i.marlon_tenant is not null, 'Marlon''s tenant was created');
  perform tests.ok(i.rhea_tenant <> i.marlon_tenant, 'the two tenants are distinct');

  perform tests.eq(
    (select role::text from public.tenant_members
      where tenant_id = i.rhea_tenant and user_id = i.rhea),
    'owner', 'create_tenant() made the creator an owner');
  perform tests.ok(
    (select accepted_at is not null from public.tenant_members
      where tenant_id = i.rhea_tenant and user_id = i.rhea),
    'the creator''s membership is accepted immediately');
end;
$$;

-- Slug rules are enforced by the database, not just the client.
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
begin
  perform tests.rejects(
    $q$ select public.create_tenant('Bad', 'ab') $q$,
    'create_tenant rejects a slug shorter than 3 characters');
  perform tests.rejects(
    $q$ select public.create_tenant('Bad', 'Rhea Shop') $q$,
    'create_tenant rejects a slug that is not a DNS label');
  perform tests.rejects(
    $q$ select public.create_tenant('Bad', 'admin') $q$,
    'create_tenant rejects a reserved slug');
  perform tests.rejects(
    $q$ select public.create_tenant('Dupe', 'marlon-kicks') $q$,
    'create_tenant rejects a slug already taken');
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- THE CORE ASSERTION — cross-tenant reads return zero rows
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Cross-tenant isolation (reads)'

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

do $$
declare i record;
begin
  select * into i from tests.ids;

  -- tenants
  perform tests.eq((select count(*)::int from public.tenants), 1,
    'Rhea sees exactly one tenant');
  perform tests.eq((select count(*)::int from public.tenants where id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s tenant, even addressing it by id');
  perform tests.eq((select count(*)::int from public.tenants where slug = 'marlon-kicks'), 0,
    'Rhea cannot read Marlon''s tenant by slug');

  -- tenant_members
  perform tests.eq((select count(*)::int from public.tenant_members), 1,
    'Rhea sees only her own membership row');
  perform tests.eq(
    (select count(*)::int from public.tenant_members where tenant_id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s roster');

  -- profiles
  perform tests.eq((select count(*)::int from public.profiles where id = i.marlon), 0,
    'Rhea cannot read Marlon''s profile — they share no tenant');
  perform tests.eq((select count(*)::int from public.profiles where id = i.rhea), 1,
    'Rhea can read her own profile');

  -- invitations
  perform tests.eq((select count(*)::int from public.invitations), 0,
    'Rhea sees no invitations yet');

  -- The blunt version of the same question, across every table at once.
  perform tests.eq(
    (select count(*)::int from public.tenants) +
    (select count(*)::int from public.tenant_members) +
    (select count(*)::int from public.profiles) +
    (select count(*)::int from public.invitations),
    3, 'total rows visible to Rhea = 1 tenant + 1 membership + 1 profile, nothing else');
end;
$$;

-- Same again from Marlon's side, so the result is not an artefact of ordering.
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.tenants), 1,
    'Marlon sees exactly one tenant');
  perform tests.eq((select count(*)::int from public.tenants where id = i.rhea_tenant), 0,
    'Marlon cannot read Rhea''s tenant');
  perform tests.eq((select count(*)::int from public.tenant_members where tenant_id = i.rhea_tenant), 0,
    'Marlon cannot read Rhea''s roster');
  perform tests.eq((select count(*)::int from public.profiles where id = i.rhea), 0,
    'Marlon cannot read Rhea''s profile');
end;
$$;

-- A user with no memberships sees nothing but themselves.
select tests.login('44444444-4444-4444-4444-444444444444', 'nica@example.ph');
do $$
begin
  perform tests.eq((select count(*)::int from public.tenants), 0,
    'a user with no membership sees zero tenants');
  perform tests.eq((select count(*)::int from public.tenant_members), 0,
    'a user with no membership sees zero membership rows');
  perform tests.eq((select count(*)::int from public.profiles), 1,
    'a user with no membership sees only their own profile');
end;
$$;

-- ---------------------------------------------------------------------------
-- Cross-tenant writes
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Cross-tenant isolation (writes)'

select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

do $$
declare i record;
begin
  select * into i from tests.ids;

  -- RLS scopes UPDATE/DELETE to visible rows, so these affect zero rows rather
  -- than raising. Zero is the assertion.
  perform tests.eq(
    tests.affected(format(
      $q$ update public.tenants set name = 'Hacked' where id = %L $q$, i.marlon_tenant)),
    0::bigint, 'Rhea''s UPDATE of Marlon''s tenant affects zero rows');

  perform tests.eq(
    tests.affected(format(
      $q$ delete from public.tenants where id = %L $q$, i.marlon_tenant)),
    0::bigint, 'Rhea''s DELETE of Marlon''s tenant affects zero rows');

  perform tests.eq(
    tests.affected(format(
      $q$ update public.tenant_members set role = 'owner' where tenant_id = %L $q$, i.marlon_tenant)),
    0::bigint, 'Rhea cannot promote herself inside Marlon''s tenant');

  perform tests.eq(
    tests.affected(format(
      $q$ delete from public.tenant_members where tenant_id = %L $q$, i.marlon_tenant)),
    0::bigint, 'Rhea cannot remove Marlon''s members');

  perform tests.eq(
    tests.affected(format(
      $q$ update public.profiles set full_name = 'Owned' where id = %L $q$, i.marlon)),
    0::bigint, 'Rhea cannot rewrite Marlon''s profile');

  -- INSERT violates WITH CHECK, which does raise.
  perform tests.rejects(format(
    $q$ insert into public.tenant_members (tenant_id, user_id, role, accepted_at)
        values (%L, %L, 'owner', now()) $q$, i.marlon_tenant, i.rhea),
    'Rhea cannot insert herself into Marlon''s tenant');

  perform tests.rejects(format(
    $q$ insert into public.invitations (tenant_id, email, role)
        values (%L, 'attacker@example.ph', 'owner') $q$, i.marlon_tenant),
    'Rhea cannot create an invitation to Marlon''s tenant');

  -- Marlon's data is untouched.
  perform tests.ok(true, 'no cross-tenant write succeeded');
end;
$$;

reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select name from public.tenants where id = i.marlon_tenant),
    'Marlon Kicks', 'Marlon''s tenant name survived every attempt');
  perform tests.eq((select count(*)::int from public.tenant_members where tenant_id = i.marlon_tenant),
    1, 'Marlon''s roster still has exactly one member');
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Invitations'

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

do $$
declare i record;
begin
  select * into i from tests.ids;
  insert into public.invitations (tenant_id, email, role, invited_by)
  values (i.rhea_tenant, 'jess@example.ph', 'packer', i.rhea);
  perform tests.eq((select count(*)::int from public.invitations), 1,
    'Rhea (owner) can invite a packer');

  perform tests.rejects(format(
    $q$ insert into public.invitations (tenant_id, email, role)
        values (%L, 'jess@example.ph', 'packer') $q$, i.rhea_tenant),
    'a second pending invite for the same email is rejected');
end;
$$;

-- Marlon must not see or touch that invitation.
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
begin
  perform tests.eq((select count(*)::int from public.invitations), 0,
    'Marlon cannot see Rhea''s invitation');
end;
$$;

-- Jess cannot read the invitation row either — the token is not readable through
-- RLS by design, so a leaked token cannot be used to enumerate a tenant.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
begin
  perform tests.eq((select count(*)::int from public.invitations), 0,
    'the invitee cannot SELECT the invitation (token is never exposed)');
end;
$$;

-- Wrong recipient cannot redeem a token they somehow obtained.
reset role;
create table tests.token as select token from public.invitations where email = 'jess@example.ph';
grant select on tests.token to authenticated, anon;
set local role authenticated;

select tests.login('44444444-4444-4444-4444-444444444444', 'nica@example.ph');
do $$
declare v_token text;
begin
  select token into v_token from tests.token;
  perform tests.rejects(format($q$ select public.accept_invitation(%L) $q$, v_token),
    'a leaked token cannot be redeemed by a different email');
end;
$$;

do $$
begin
  perform tests.rejects($q$ select public.accept_invitation('not-a-real-token') $q$,
    'an unknown token is rejected');
end;
$$;

-- The right person can accept, and only then gains access.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare v_token text; i record;
begin
  select token into v_token from tests.token;
  select * into i from tests.ids;

  perform tests.eq((select count(*)::int from public.tenants), 0,
    'before accepting, Jess sees zero tenants');

  perform public.accept_invitation(v_token);

  perform tests.eq((select count(*)::int from public.tenants), 1,
    'after accepting, Jess sees exactly one tenant');
  perform tests.eq((select id from public.tenants), i.rhea_tenant,
    'and it is Rhea''s tenant');
  perform tests.eq((select role::text from public.tenant_members where user_id = i.jess), 'packer',
    'Jess joined with the invited role, not a role of her choosing');

  perform tests.rejects(format($q$ select public.accept_invitation(%L) $q$, v_token),
    'a token cannot be redeemed twice');
end;
$$;

-- Teammates can now see each other; Marlon still cannot see either of them.
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.profiles where id = i.rhea), 1,
    'Jess can read her teammate Rhea''s profile');
  perform tests.eq((select count(*)::int from public.profiles where id = i.marlon), 0,
    'Jess still cannot read Marlon''s profile');
end;
$$;

select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.profiles where id = i.jess), 0,
    'Marlon cannot read Jess''s profile');
  perform tests.eq((select count(*)::int from public.tenant_members), 1,
    'Marlon''s roster view did not grow when Rhea hired someone');
end;
$$;

-- ---------------------------------------------------------------------------
-- Role escalation
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Role enforcement'

select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq(
    tests.affected(format($q$ update public.tenants set name = 'Jess Store' where id = %L $q$,
      i.rhea_tenant)),
    0::bigint, 'a packer cannot rename the tenant (needs admin)');

  perform tests.eq(
    tests.affected(format($q$ delete from public.tenants where id = %L $q$, i.rhea_tenant)),
    0::bigint, 'a packer cannot delete the tenant (needs owner)');

  perform tests.rejects(format(
    $q$ insert into public.invitations (tenant_id, email, role) values (%L, 'x@example.ph', 'staff') $q$,
    i.rhea_tenant),
    'a packer cannot invite anyone');

  perform tests.rejects(format(
    $q$ insert into public.tenant_members (tenant_id, user_id, role, accepted_at)
        values (%L, %L, 'admin', now()) $q$, i.rhea_tenant, i.nica),
    'a packer cannot add members');

  perform tests.eq(
    tests.affected(format(
      $q$ update public.tenant_members set role = 'owner' where tenant_id = %L and user_id = %L $q$,
      i.rhea_tenant, i.jess)),
    0::bigint, 'a packer cannot promote herself');

  -- What she CAN do: read the roster and leave.
  perform tests.eq((select count(*)::int from public.tenant_members), 2,
    'a packer can read the roster of her own tenant');
end;
$$;

-- An admin cannot invite above their own level.
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  insert into public.tenant_members (tenant_id, user_id, role, accepted_at)
  values (i.rhea_tenant, i.nica, 'admin', now());
end;
$$;
set local role authenticated;

select tests.login('44444444-4444-4444-4444-444444444444', 'nica@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.rejects(format(
    $q$ insert into public.invitations (tenant_id, email, role) values (%L, 'boss@example.ph', 'owner') $q$,
    i.rhea_tenant),
    'an admin cannot invite someone at owner level');

  insert into public.invitations (tenant_id, email, role)
  values (i.rhea_tenant, 'staffer@example.ph', 'staff');
  perform tests.ok(true, 'an admin can invite at or below their own level');
end;
$$;

-- ---------------------------------------------------------------------------
-- Last-owner protection
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Last-owner protection'

select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.rejects(format(
    $q$ update public.tenant_members set role = 'admin' where tenant_id = %L and user_id = %L $q$,
    i.rhea_tenant, i.rhea),
    'the last owner cannot demote themselves');

  perform tests.rejects(format(
    $q$ delete from public.tenant_members where tenant_id = %L and user_id = %L $q$,
    i.rhea_tenant, i.rhea),
    'the last owner cannot leave and orphan the store');
end;
$$;

-- With a second owner, the first may step down.
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.tenant_members set role = 'owner'
    where tenant_id = i.rhea_tenant and user_id = i.nica;
end;
$$;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq(
    tests.affected(format(
      $q$ update public.tenant_members set role = 'admin' where tenant_id = %L and user_id = %L $q$,
      i.rhea_tenant, i.rhea)),
    1::bigint, 'an owner may step down once a second owner exists');
end;
$$;

-- ---------------------------------------------------------------------------
-- current_tenant_id()
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== current_tenant_id()'

select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.set_tenant_header(i.marlon_tenant::text);
  perform tests.eq(public.current_tenant_id(), i.marlon_tenant,
    'the header selects the tenant when the caller is a member');

  -- The attack: point the header at somebody else's tenant.
  perform tests.set_tenant_header(i.rhea_tenant::text);
  perform tests.eq(public.current_tenant_id(), i.marlon_tenant,
    'a spoofed header falls back to the caller''s own tenant, never Rhea''s');

  perform tests.set_tenant_header('not-a-uuid');
  perform tests.eq(public.current_tenant_id(), i.marlon_tenant,
    'a malformed header does not raise, it falls back');

  perform set_config('request.headers', '', true);
  perform tests.eq(public.current_tenant_id(), i.marlon_tenant,
    'with no header at all it returns the caller''s oldest membership');
end;
$$;

select tests.login('44444444-4444-4444-4444-444444444444', 'nica@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq(public.current_tenant_id(), i.rhea_tenant,
    'a member of one tenant resolves to it without a header');
end;
$$;

-- ---------------------------------------------------------------------------
-- Anonymous / storefront access
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Anonymous access'

reset role;
set local role anon;
select tests.logout();

do $$
begin
  perform tests.rejects($q$ select count(*) from public.tenants $q$,
    'anon has no privilege on tenants at all');
  perform tests.rejects($q$ select count(*) from public.tenant_members $q$,
    'anon has no privilege on tenant_members');
  perform tests.rejects($q$ select count(*) from public.profiles $q$,
    'anon has no privilege on profiles');
  perform tests.rejects($q$ select count(*) from public.invitations $q$,
    'anon has no privilege on invitations');
end;
$$;

-- But the storefront must resolve {slug}.selld.ph without a session.
do $$
begin
  perform tests.eq((select count(*)::int from public.storefront_tenants), 2,
    'anon CAN read the public storefront projection');
  perform tests.eq((select name from public.storefront_tenants where slug = 'rheas-finds'),
    'Rhea''s Finds', 'anon can resolve a store by slug');
end;
$$;

-- The projection must not leak anything but branding.
do $$
declare v_columns text[];
begin
  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'storefront_tenants';

  perform tests.eq(v_columns,
    array['brand_color','custom_domain','id','locale','logo_path','name','slug'],
    'storefront_tenants exposes only public branding columns');
end;
$$;

-- Suspended stores drop out of the public projection.
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.tenants set status = 'suspended' where id = i.marlon_tenant;
end;
$$;
set local role anon;
do $$
begin
  perform tests.eq((select count(*)::int from public.storefront_tenants), 1,
    'a suspended store disappears from the public projection');
end;
$$;

-- ---------------------------------------------------------------------------
-- Phase 2 tables — settings, locations, themes
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Onboarding tables (tenant_settings, locations, storefront_themes)'

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

do $$
declare i record;
begin
  select * into i from tests.ids;

  -- Defaults were seeded by the tenant trigger, not by the wizard.
  perform tests.eq((select count(*)::int from public.storefront_themes), 1,
    'Rhea sees exactly one theme row — her own');
  perform tests.ok((select count(*) from public.tenant_settings) >= 9,
    'default settings were seeded on tenant creation');
  perform tests.eq(
    (select value from public.tenant_settings
      where tenant_id = i.rhea_tenant and key = 'payments.cod_enabled'),
    'true'::jsonb, 'COD is enabled by default');

  -- Cross-tenant reads see nothing.
  perform tests.eq(
    (select count(*)::int from public.storefront_themes where tenant_id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s theme');
  perform tests.eq(
    (select count(*)::int from public.tenant_settings where tenant_id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s settings');

  -- Cross-tenant writes fail.
  perform tests.eq(
    tests.affected(format(
      $q$ update public.storefront_themes set preset = 'bold' where tenant_id = %L $q$,
      i.marlon_tenant)),
    0::bigint, 'Rhea cannot restyle Marlon''s storefront');
  perform tests.rejects(format(
    $q$ insert into public.tenant_settings (tenant_id, key, value)
        values (%L, 'payments.cod_enabled', 'false'::jsonb) $q$, i.marlon_tenant),
    'Rhea cannot write settings into Marlon''s tenant');
  perform tests.rejects(format(
    $q$ insert into public.locations (tenant_id, name) values (%L, 'Stolen warehouse') $q$,
    i.marlon_tenant),
    'Rhea cannot create a location in Marlon''s tenant');

  -- Her own writes work.
  insert into public.locations (tenant_id, name, type, is_default, region_code, city_code)
  values (i.rhea_tenant, 'Home', 'home', true, '110000000', '112402000');
  perform tests.eq((select count(*)::int from public.locations), 1,
    'Rhea can create her own location');

  update public.storefront_themes
    set preset = 'bold', colors = '{"primary":"#12604f"}'::jsonb
    where tenant_id = i.rhea_tenant;
  perform tests.eq(
    (select preset from public.storefront_themes where tenant_id = i.rhea_tenant),
    'bold', 'Rhea can restyle her own storefront');
end;
$$;

-- Theme colours are validated in the database, not just the form.
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.rejects(format(
    $q$ update public.storefront_themes set colors = '{"primary":"red"}'::jsonb where tenant_id = %L $q$,
    i.rhea_tenant),
    'a non-hex theme colour is rejected');
  perform tests.rejects(format(
    $q$ update public.storefront_themes set colors = '{"primary":"#GGG"}'::jsonb where tenant_id = %L $q$,
    i.rhea_tenant),
    'a malformed hex theme colour is rejected');
  perform tests.rejects(format(
    $q$ update public.storefront_themes set colors = '{"primary":123}'::jsonb where tenant_id = %L $q$,
    i.rhea_tenant),
    'a non-string theme colour is rejected');
end;
$$;

-- Only one default location per tenant, enforced by index rather than by code.
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.rejects(format(
    $q$ insert into public.locations (tenant_id, name, is_default) values (%L, 'Second default', true) $q$,
    i.rhea_tenant),
    'a tenant cannot have two default locations');

  -- A second non-default location is fine.
  insert into public.locations (tenant_id, name, is_default)
  values (i.rhea_tenant, 'Consignment shelf', false);
  perform tests.eq((select count(*)::int from public.locations), 2,
    'additional non-default locations are allowed');
end;
$$;

-- Role enforcement on the phase 2 tables: a packer reads, never writes.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.locations), 2,
    'a packer can read locations (needed to pick and pack)');
  perform tests.ok((select count(*) from public.tenant_settings) >= 9,
    'a packer can read settings (COD policy affects packing slips)');

  -- But changing where the business ships from, or its payment policy, is admin work.
  perform tests.rejects(format(
    $q$ insert into public.locations (tenant_id, name) values (%L, 'Packer warehouse') $q$,
    i.rhea_tenant),
    'a packer cannot create a location');
  perform tests.eq(
    tests.affected(format(
      $q$ update public.locations set name = 'Renamed' where tenant_id = %L $q$, i.rhea_tenant)),
    0::bigint, 'a packer cannot rename a location');
  perform tests.eq(
    tests.affected(format(
      $q$ update public.tenant_settings set value = 'false'::jsonb
          where tenant_id = %L and key = 'payments.cod_enabled' $q$, i.rhea_tenant)),
    0::bigint, 'a packer cannot switch off COD');
  perform tests.eq(
    tests.affected(format(
      $q$ update public.storefront_themes set preset = 'mono' where tenant_id = %L $q$,
      i.rhea_tenant)),
    0::bigint, 'a packer cannot restyle the storefront');
end;
$$;

-- Anonymous storefront branding.
reset role;
set local role anon;
select tests.logout();
do $$
begin
  perform tests.rejects($q$ select count(*) from public.storefront_themes $q$,
    'anon has no privilege on storefront_themes');
  perform tests.rejects($q$ select count(*) from public.tenant_settings $q$,
    'anon has no privilege on tenant_settings');
  perform tests.rejects($q$ select count(*) from public.locations $q$,
    'anon cannot read where a seller lives');
  perform tests.ok((select count(*) from public.storefront_theme_public) >= 1,
    'anon CAN read public storefront branding');
end;
$$;

do $$
declare v_columns text[];
begin
  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'storefront_theme_public';
  perform tests.eq(v_columns,
    array['colors','custom_css','fonts','hero','preset','slug','tenant_id'],
    'storefront_theme_public exposes only branding columns');
end;
$$;

reset role;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Phase 3 tables — catalog
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Catalog (products, options, variants, images)'

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- Build a real 2-option product so the isolation checks have something to hide.
do $$
declare
  i record; p uuid; o1 uuid; o2 uuid; s uuid; m uuid; blk uuid; wht uuid;
begin
  select * into i from tests.ids;

  insert into public.categories (tenant_id, name, slug)
  values (i.rhea_tenant, 'Skincare', 'skincare');

  insert into public.products (tenant_id, name, slug, status)
  values (i.rhea_tenant, 'Whitening Soap', 'whitening-soap', 'active') returning id into p;

  insert into public.product_options (tenant_id, product_id, name, sort_order)
  values (i.rhea_tenant, p, 'Size', 0) returning id into o1;
  insert into public.product_options (tenant_id, product_id, name, sort_order)
  values (i.rhea_tenant, p, 'Scent', 1) returning id into o2;

  insert into public.product_option_values (tenant_id, option_id, value) values (i.rhea_tenant, o1, '135g') returning id into s;
  insert into public.product_option_values (tenant_id, option_id, value) values (i.rhea_tenant, o1, '65g') returning id into m;
  insert into public.product_option_values (tenant_id, option_id, value) values (i.rhea_tenant, o2, 'Kojic') returning id into blk;
  insert into public.product_option_values (tenant_id, option_id, value) values (i.rhea_tenant, o2, 'Papaya') returning id into wht;

  insert into public.product_variants (tenant_id, product_id, sku, price_centavos, option_value_ids) values
    (i.rhea_tenant, p, 'RF-135-K', 14900, array[s, blk]),
    (i.rhea_tenant, p, 'RF-135-P', 14900, array[s, wht]),
    (i.rhea_tenant, p, 'RF-65-K',   8900, array[m, blk]),
    (i.rhea_tenant, p, 'RF-65-P',   8900, array[m, wht]);

  perform tests.eq((select count(*)::int from public.product_variants), 4,
    'Rhea created a 2x2 variant matrix');
  perform tests.eq((select count(*)::int from public.products), 1, 'Rhea sees her product');
end;
$$;

-- Marlon must see none of it.
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.products), 0,
    'Marlon cannot see Rhea''s products');
  perform tests.eq((select count(*)::int from public.product_variants), 0,
    'Marlon cannot see Rhea''s variants — where the prices live');
  perform tests.eq((select count(*)::int from public.product_options), 0,
    'Marlon cannot see Rhea''s options');
  perform tests.eq((select count(*)::int from public.product_option_values), 0,
    'Marlon cannot see Rhea''s option values');
  perform tests.eq((select count(*)::int from public.categories), 0,
    'Marlon cannot see Rhea''s categories');

  -- A competitor reading cost_centavos would know her margins exactly.
  perform tests.eq(
    (select count(*)::int from public.product_variants where tenant_id = i.rhea_tenant), 0,
    'Marlon cannot read Rhea''s costs even addressing her tenant directly');

  perform tests.eq(
    tests.affected(format($q$ update public.product_variants set price_centavos = 1 where tenant_id = %L $q$,
      i.rhea_tenant)),
    0::bigint, 'Marlon cannot reprice Rhea''s catalog');
  perform tests.rejects(format(
    $q$ insert into public.products (tenant_id, name, slug) values (%L, 'Injected', 'injected') $q$,
    i.rhea_tenant),
    'Marlon cannot insert a product into Rhea''s catalog');
end;
$$;

-- The composite foreign keys make a cross-tenant child unrepresentable, which is
-- a stronger guarantee than a policy: it holds even for a definer function.
do $$
declare i record; v_product uuid;
begin
  select * into i from tests.ids;
  reset role;
  select id into v_product from public.products where slug = 'whitening-soap';
  set local role authenticated;
  perform tests.rejects(format(
    $q$ insert into public.product_options (tenant_id, product_id, name)
        values (%L, %L, 'Stolen') $q$, i.marlon_tenant, v_product),
    'composite FK blocks a child row claiming another tenant');
end;
$$;

-- Role enforcement: a packer reads the catalog, never reprices it.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.products), 1,
    'a packer can read products (needed to pick)');
  perform tests.eq(
    tests.affected($q$ update public.product_variants set price_centavos = 1 $q$),
    0::bigint, 'a packer cannot change a price');
  perform tests.rejects(format(
    $q$ insert into public.products (tenant_id, name, slug) values (%L, 'X', 'x') $q$, i.rhea_tenant),
    'a packer cannot create a product');
end;
$$;

-- SKU uniqueness is per tenant: two sellers may legitimately use "RF-135-K".
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record; p uuid;
begin
  select * into i from tests.ids;
  insert into public.products (tenant_id, name, slug) values (i.marlon_tenant, 'Kicks', 'kicks')
    returning id into p;
  insert into public.product_variants (tenant_id, product_id, sku, price_centavos)
  values (i.marlon_tenant, p, 'RF-135-K', 99900);
  perform tests.ok(true, 'the same SKU is allowed in a different tenant');

  perform tests.rejects(format(
    $q$ insert into public.product_variants (tenant_id, product_id, sku, price_centavos)
        values (%L, %L, 'RF-135-K', 88800) $q$, i.marlon_tenant, p),
    'a duplicate SKU within one tenant is rejected');
end;
$$;

-- Anonymous storefront: active products readable, costs never exposed.
reset role;
set local role anon;
select tests.logout();
do $$
declare v_columns text[];
begin
  perform tests.rejects($q$ select count(*) from public.products $q$,
    'anon has no privilege on products');
  perform tests.rejects($q$ select count(*) from public.product_variants $q$,
    'anon has no privilege on product_variants');

  perform tests.eq((select count(*)::int from public.storefront_products), 1,
    'anon CAN read active products through the projection');
  perform tests.eq((select count(*)::int from public.storefront_variants), 4,
    'anon CAN read purchasable variants');

  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'storefront_variants';
  perform tests.ok(not ('cost_centavos' = any (v_columns)),
    'storefront_variants does NOT expose cost_centavos — that is her margin');

  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'storefront_products';
  perform tests.ok(not ('status' = any (v_columns)),
    'storefront_products does not leak draft status');
end;
$$;

-- A draft product must not appear on the storefront.
reset role;
do $$
begin
  update public.products set status = 'draft' where slug = 'whitening-soap';
end;
$$;
set local role anon;
do $$
begin
  perform tests.eq((select count(*)::int from public.storefront_products), 0,
    'a draft product is invisible to buyers');
  perform tests.eq((select count(*)::int from public.storefront_variants), 0,
    'and so are its variants');
end;
$$;

reset role;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Phase 4 tables — inventory
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Inventory (levels, ledger)'

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

do $$
declare i record; v uuid; loc uuid;
begin
  select * into i from tests.ids;
  select id into loc from public.locations where tenant_id = i.rhea_tenant and is_default;
  select id into v from public.product_variants where tenant_id = i.rhea_tenant limit 1;

  -- Stock arrives through the ledger; there is no other way in.
  perform public.record_stock_movement(i.rhea_tenant, v, loc, 20, 'receive', 'first delivery');
  perform tests.eq(
    (select on_hand from public.inventory_levels where variant_id = v and location_id = loc),
    20, 'a receive movement created the level row and set on_hand');
  perform tests.eq(
    (select count(*)::int from public.stock_movements where variant_id = v), 1,
    'and left exactly one ledger entry');

  -- Reserve, then check the arithmetic a buyer actually depends on.
  perform public.reserve_stock(i.rhea_tenant, loc,
    jsonb_build_array(jsonb_build_object('variant_id', v, 'qty', 5)));
  perform tests.eq(
    (select reserved from public.inventory_levels where variant_id = v), 5,
    'reserving moved 5 units into reserved');
  perform tests.eq(
    (select on_hand from public.inventory_levels where variant_id = v), 20,
    'and did NOT touch on_hand — a reservation is not a movement');
  perform tests.eq(
    (select available from public.inventory_overview where variant_id = v), 15,
    'available = on_hand - reserved');

  -- The oversell guard, single-threaded. (The real race lives in
  -- scripts/db-concurrency-test.ts, which needs parallel connections.)
  perform tests.rejects(format(
    $q$ select public.reserve_stock(%L, %L, jsonb_build_array(jsonb_build_object('variant_id', %L, 'qty', 16))) $q$,
    i.rhea_tenant, loc, v),
    'reserving more than available is refused');

  -- Shipping converts a reservation into a sale, in one transaction.
  perform public.ship_reservation(i.rhea_tenant, loc,
    jsonb_build_array(jsonb_build_object('variant_id', v, 'qty', 5)));
  perform tests.eq(
    (select on_hand from public.inventory_levels where variant_id = v), 15,
    'shipping reduced on_hand');
  perform tests.eq(
    (select reserved from public.inventory_levels where variant_id = v), 0,
    'and cleared the reservation');

  -- The invariant that makes the ledger trustworthy.
  perform tests.eq(
    (select coalesce(sum(delta), 0)::int from public.stock_movements where variant_id = v),
    (select on_hand from public.inventory_levels where variant_id = v),
    'on_hand equals the sum of its movements');

  -- A movement that would take stock below what is committed must fail.
  perform public.reserve_stock(i.rhea_tenant, loc,
    jsonb_build_array(jsonb_build_object('variant_id', v, 'qty', 15)));
  perform tests.rejects(format(
    $q$ select public.record_stock_movement(%L, %L, %L, -1, 'damage', 'breaks the reservation') $q$,
    i.rhea_tenant, v, loc),
    'stock cannot drop below what is already reserved');
  perform public.release_reservation(i.rhea_tenant, loc,
    jsonb_build_array(jsonb_build_object('variant_id', v, 'qty', 15)));

  -- Nor below zero.
  perform tests.rejects(format(
    $q$ select public.record_stock_movement(%L, %L, %L, -999, 'damage', 'too much') $q$,
    i.rhea_tenant, v, loc),
    'stock cannot go negative');

  -- A double release must not manufacture availability.
  perform public.release_reservation(i.rhea_tenant, loc,
    jsonb_build_array(jsonb_build_object('variant_id', v, 'qty', 100)));
  perform tests.eq(
    (select reserved from public.inventory_levels where variant_id = v), 0,
    'over-releasing floors reserved at zero rather than going negative');

  -- Direct writes to the derived column, and to the ledger, are refused.
  perform tests.rejects(format(
    $q$ update public.inventory_levels set on_hand = 999 where variant_id = %L $q$, v),
    'on_hand cannot be written directly — it is derived from the ledger');
  perform tests.rejects(format(
    $q$ update public.stock_movements set delta = 0 where variant_id = %L $q$, v),
    'the ledger is append-only');
end;
$$;

-- Cross-tenant: stock levels are commercially sensitive.
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.inventory_levels), 0,
    'Marlon cannot see Rhea''s stock levels');
  perform tests.eq((select count(*)::int from public.stock_movements), 0,
    'Marlon cannot read Rhea''s stock history');
  perform tests.eq((select count(*)::int from public.inventory_overview), 0,
    'nor through the overview view');

  perform tests.eq(
    tests.affected(format(
      $q$ update public.inventory_levels set low_stock_threshold = 1 where tenant_id = %L $q$,
      i.rhea_tenant)),
    0::bigint, 'Marlon cannot change Rhea''s thresholds');
end;
$$;

-- A non-member cannot reserve against another tenant's stock.
do $$
declare i record; v uuid; loc uuid;
begin
  select * into i from tests.ids;
  reset role;
  select id into loc from public.locations where tenant_id = i.rhea_tenant and is_default;
  select id into v from public.product_variants where tenant_id = i.rhea_tenant limit 1;
  set local role authenticated;

  perform tests.rejects(format(
    $q$ select public.reserve_stock(%L, %L, jsonb_build_array(jsonb_build_object('variant_id', %L, 'qty', 1))) $q$,
    i.rhea_tenant, loc, v),
    'a non-member cannot reserve another tenant''s stock');
  perform tests.rejects(format(
    $q$ select public.record_stock_movement(%L, %L, %L, 5, 'receive') $q$,
    i.rhea_tenant, v, loc),
    'a non-member cannot add stock to another tenant');
end;
$$;

-- Role enforcement: a packer reads stock and ships, but does not decide quantities.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record; v uuid; loc uuid;
begin
  select * into i from tests.ids;
  reset role;
  select id into loc from public.locations where tenant_id = i.rhea_tenant and is_default;
  select id into v from public.product_variants where tenant_id = i.rhea_tenant limit 1;
  set local role authenticated;

  perform tests.ok((select count(*) from public.inventory_levels) >= 1,
    'a packer can read stock levels');
  perform tests.rejects(format(
    $q$ select public.record_stock_movement(%L, %L, %L, 10, 'receive') $q$,
    i.rhea_tenant, v, loc),
    'a packer cannot adjust stock');
  perform tests.eq(
    tests.affected(format(
      $q$ update public.inventory_levels set low_stock_threshold = 99 where tenant_id = %L $q$,
      i.rhea_tenant)),
    0::bigint, 'a packer cannot change thresholds');
end;
$$;

-- Buyers see whether something is buyable, never how much of it there is.
reset role;
set local role anon;
select tests.logout();
do $$
declare v_columns text[];
begin
  perform tests.rejects($q$ select count(*) from public.inventory_levels $q$,
    'anon has no privilege on inventory_levels');
  perform tests.rejects($q$ select count(*) from public.stock_movements $q$,
    'anon cannot read the stock ledger');
  perform tests.rejects($q$ select count(*) from public.inventory_overview $q$,
    'anon cannot read the inventory overview');

  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'storefront_availability';
  perform tests.eq(v_columns,
    array['in_stock', 'product_id', 'stock_state', 'tenant_id', 'variant_id'],
    'storefront_availability exposes a boolean and a bucket, never a count');
  perform tests.ok(not ('on_hand' = any (v_columns)), 'and definitely not on_hand');
end;
$$;

reset role;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Phase 5: the storefront read model
-- ---------------------------------------------------------------------------
-- Every page of a storefront is rendered by an anonymous request, so these
-- functions are the widest anonymous surface in the product. They read the
-- storefront_* projections rather than the base tables, and that boundary is
-- what the assertions below pin down.
\echo ''
\echo '=== Phase 5: storefront read model'

-- Restore two things earlier sections deliberately switched off.
--
-- `whitening-soap` was left as a draft to prove drafts are invisible, and Marlon's
-- tenant was left suspended to prove a suspended store goes dark. Both need to be
-- live here, and the second one matters more than it looks: with Marlon suspended,
-- the cross-tenant assertion below passes because his *store* cannot be resolved,
-- not because his store refuses to serve Rhea's product. That is a test that
-- passes for the wrong reason and would keep passing if the isolation broke.
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.products set status = 'active' where slug = 'whitening-soap';
  update public.tenants  set status = 'active' where id = i.marlon_tenant;
end;
$$;

set local role anon;
select tests.logout();
do $$
declare
  i        record;
  v_home   jsonb;
  v_page   jsonb;
  v_text   text;
begin
  select * into i from tests.ids;

  -- Resolution ------------------------------------------------------------
  perform tests.eq(public.storefront_tenant_id('rheas-finds'), i.rhea_tenant,
    'anon resolves a store by slug');
  perform tests.ok(public.storefront_tenant_id('no-such-store') is null,
    'an unknown slug resolves to null, not an error');
  perform tests.ok(public.storefront_tenant_id(null, 'not-a-domain.example') is null,
    'an unknown custom domain resolves to null');

  -- A Host header is attacker-controlled. Passing both must never let a domain
  -- override an explicit slug, or one store could be rendered under another's.
  perform tests.eq(public.storefront_tenant_id('rheas-finds', 'marlon-kicks.example'),
    i.rhea_tenant, 'slug wins over a supplied domain');

  -- Home page -------------------------------------------------------------
  v_home := public.storefront_home('rheas-finds');
  perform tests.ok(v_home is not null, 'anon can render the home page');
  perform tests.eq(v_home -> 'store' ->> 'slug', 'rheas-finds',
    'and it carries the right store');
  perform tests.ok(public.storefront_home('no-such-store') is null,
    'a missing store returns null so the server can send a real 404');

  -- Cross-tenant: Rhea's home must contain none of Marlon's catalog.
  v_text := v_home::text;
  perform tests.ok(v_text not like '%marlon%',
    'one store''s home page contains nothing of another''s');

  -- The whole reason cost_centavos is excluded from the projections.
  perform tests.ok(v_text not ilike '%cost%',
    'the home payload never mentions cost');
  perform tests.ok(v_text not like '%on_hand%' and v_text not like '%reserved%',
    'and never exposes stock counts');

  -- Product page ----------------------------------------------------------
  v_page := public.storefront_product_page('whitening-soap', 'rheas-finds');
  perform tests.ok(v_page is not null, 'anon can render a product page');
  perform tests.ok(v_page -> 'product' is not null, 'the product is present');
  perform tests.ok((v_page -> 'variants') <> '[]'::jsonb, 'with its variants');
  perform tests.ok(v_page::text not ilike '%cost%',
    'the product payload never mentions cost');

  -- A product that does not exist still returns the store, so the 404 page can
  -- be branded — but `product` must be null so the server sends 404 not 200.
  v_page := public.storefront_product_page('no-such-product', 'rheas-finds');
  perform tests.ok(v_page is not null and v_page -> 'store' is not null,
    'an unknown product still resolves the store for a branded 404');
  perform tests.ok(v_page -> 'product' = 'null'::jsonb,
    'and reports the product as null');

  -- Asking for one store's product under another store's slug must not find it.
  perform tests.ok(
    public.storefront_product_page('whitening-soap', 'marlon-kicks') -> 'product'
      = 'null'::jsonb,
    'a product cannot be fetched through another store''s slug');

  -- Paging is clamped, not trusted -----------------------------------------
  -- p_limit arrives from a query string. Unbounded, it turns the catalog into a
  -- single-request scrape.
  perform tests.ok(
    jsonb_array_length(public.storefront_home('rheas-finds', null, null, null, 100000) -> 'products')
      <= 96,
    'an absurd page size is clamped');
  perform tests.ok(
    jsonb_array_length(public.storefront_home('rheas-finds', null, null, null, -5) -> 'products')
      >= 1,
    'a negative page size still returns something');

  -- Sitemap ---------------------------------------------------------------
  perform tests.ok(public.storefront_sitemap('rheas-finds') is not null,
    'anon can read the sitemap payload');
  perform tests.ok(public.storefront_sitemap('no-such-store') is null,
    'and gets null for a store that does not exist');
end;
$$;

-- The option matrix reaches the picker through owner-run views, NOT through a
-- grant on the base tables. If someone "simplifies" that later, these fail.
do $$
begin
  perform tests.rejects($q$ select count(*) from public.product_options $q$,
    'anon has no privilege on product_options');
  perform tests.rejects($q$ select count(*) from public.product_option_values $q$,
    'anon has no privilege on product_option_values');
  perform tests.ok((select count(*) from public.storefront_product_options) >= 0,
    'anon CAN read the option-name projection');
  perform tests.ok((select count(*) from public.storefront_option_values) >= 0,
    'anon CAN read the option-value projection');
end;
$$;

-- A suspended store must go dark everywhere at once. Suspension is how a
-- non-paying or abusive tenant is switched off, so a projection that ignores it
-- keeps serving a store we meant to stop serving.
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.tenants set status = 'suspended' where id = i.rhea_tenant;
end;
$$;

set local role anon;
select tests.logout();
do $$
begin
  perform tests.ok(public.storefront_tenant_id('rheas-finds') is null,
    'a suspended store stops resolving');
  perform tests.ok(public.storefront_home('rheas-finds') is null,
    'a suspended store''s home page is gone');
  perform tests.ok(
    public.storefront_product_page('whitening-soap', 'rheas-finds') is null,
    'and so are its product pages');
  perform tests.eq((select count(*)::int from public.storefront_products), 0,
    'and it disappears from the catalog projection');
end;
$$;

reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.tenants set status = 'active' where id = i.rhea_tenant;
end;
$$;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- Phase 6: carts, orders and the token boundary
-- ---------------------------------------------------------------------------
-- This phase introduces a *second* authorisation model. Everywhere else the
-- boundary is `is_tenant_member(tenant_id)`; a buyer has no account, so the
-- boundary is the cart token. Both have to hold, and the token one is new, so it
-- gets the most attention here.
\echo ''
\echo '=== Phase 6: cart / checkout'

reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;
  update public.products set status = 'active' where slug = 'whitening-soap';
  update public.tenants  set status = 'active' where id = i.marlon_tenant;
  -- Checkout needs stock and somewhere to hold it.
  insert into public.locations (tenant_id, name, type, is_default)
  values (i.rhea_tenant, 'Test location', 'home', true)
  on conflict do nothing;
end;
$$;

do $$
declare i record; v_variant uuid; v_location uuid;
begin
  select * into i from tests.ids;
  select id into v_location from public.locations where tenant_id = i.rhea_tenant limit 1;
  select v.id into v_variant from public.product_variants v
    join public.products p on p.id = v.product_id
  where p.slug = 'whitening-soap' limit 1;
  insert into public.stock_movements (tenant_id, variant_id, location_id, delta, reason)
  values (i.rhea_tenant, v_variant, v_location, 50, 'receive');
end;
$$;

set local role anon;
select tests.logout();
do $$
declare
  v_token   text;
  v_other   text;
  v_variant uuid;
  v_view    jsonb;
  v_order   jsonb;
  v_addr    jsonb;
begin
  -- anon must reach none of these tables. The whole model depends on it.
  perform tests.rejects($q$ select count(*) from public.carts $q$,
    'anon has no privilege on carts');
  perform tests.rejects($q$ select count(*) from public.cart_items $q$,
    'anon has no privilege on cart_items');
  perform tests.rejects($q$ select count(*) from public.orders $q$,
    'anon has no privilege on orders');
  perform tests.rejects($q$ select count(*) from public.order_items $q$,
    'anon has no privilege on order_items');
  perform tests.rejects($q$ select count(*) from public.customers $q$,
    'anon has no privilege on customers');
  perform tests.rejects($q$ select count(*) from public.order_counters $q$,
    'anon cannot read the order number counter');
  perform tests.rejects($q$ select count(*) from public.sms_logs $q$,
    'anon cannot read sms logs');
  perform tests.rejects($q$ select count(*) from public.integration_logs $q$,
    'anon cannot read integration logs');

  -- Nor the internal functions, which do no authorisation of their own.
  perform tests.rejects($q$ select public.cart_pricing('00000000-0000-0000-0000-000000000000') $q$,
    'anon cannot call cart_pricing directly');
  perform tests.rejects(
    $q$ select public.apply_reservation('00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000000', '[]'::jsonb) $q$,
    'anon cannot call apply_reservation directly');
  perform tests.rejects($q$ select public.order_receipt('00000000-0000-0000-0000-000000000000') $q$,
    'anon cannot read an order by id');

  -- A forged token must resolve to nothing rather than to somebody's cart.
  perform tests.ok(public.cart_view(repeat('a', 64)) is null,
    'a forged cart token resolves to nothing');

  v_token := public.cart_create('rheas-finds');
  perform tests.eq(length(v_token), 64, 'a cart token is 32 bytes of hex');

  select v.id into v_variant from public.storefront_variants v
    join public.storefront_products p on p.id = v.product_id
  where p.slug = 'whitening-soap' limit 1;

  v_view := public.cart_add_item(v_token, v_variant, 2);
  perform tests.eq((v_view ->> 'itemCount')::int, 2, 'anon can add to their own cart');

  -- Cross-cart: a second cart must not see the first one's contents.
  v_other := public.cart_create('rheas-finds');
  perform tests.eq((public.cart_view(v_other) ->> 'itemCount')::int, 0,
    'one cart token cannot see another cart''s items');

  -- A variant from another store cannot be added, even with a valid token.
  perform tests.rejects(
    format($q$ select public.cart_add_item(%L, (select v.id from public.product_variants v
      join public.products p on p.id = v.product_id where p.slug = 'kicks' limit 1), 1) $q$, v_token),
    'a variant from another store cannot be added to this cart');

  -- Hard rule 6 gets its own pinned section below.
  perform tests.eq(
    (public.cart_view(v_token) ->> 'subtotal')::bigint,
    2 * (select price_centavos from public.storefront_variants where id = v_variant)::bigint,
    'the quote prices from the live variant price');
end;
$$;

-- ---- Hard rule 6, properly pinned -------------------------------------
-- The tamper and the assertion must act on the SAME cart. An earlier version of
-- this picked the cart with `order by created_at desc offset 1`, tampered with one
-- row and asserted on another — and it passed even when `cart_pricing` was
-- rewritten to trust the client's snapshot. A test that survives the sabotage it
-- exists to catch is worse than no test, so the token is stashed and reused.
--
-- `reset role` first: the previous section left the session as `anon`, which cannot
-- create anything in the tests schema.
reset role;
create table tests.cart_under_test (token text primary key);
grant usage on schema tests to anon, authenticated;
grant select, insert on tests.cart_under_test to anon, authenticated;

reset role;
set local role anon;
select tests.logout();
do $$
declare v_token text; v_variant uuid;
begin
  v_token := public.cart_create('rheas-finds');
  select v.id into v_variant from public.storefront_variants v
    join public.storefront_products p on p.id = v.product_id
  where p.slug = 'whitening-soap' limit 1;
  perform public.cart_add_item(v_token, v_variant, 3);
  reset role;
  insert into tests.cart_under_test (token) values (v_token);
end;
$$;

-- Rewrite the snapshot to 1 centavo — the strongest form of the attack, since a
-- real client can only influence this column indirectly.
reset role;
update public.cart_items ci set unit_price_centavos = 1
from public.carts c, tests.cart_under_test t
where c.id = ci.cart_id and c.token = t.token;

set local role anon;
select tests.logout();
do $$
declare
  v_token    text;
  v_expected bigint;
  v_order    jsonb;
  v_addr     jsonb;
  v_brgy text; v_city text; v_region text;
begin
  select token into v_token from tests.cart_under_test;

  reset role;
  -- What the buyer must be charged: the live catalog price times the quantity.
  select sum(v.price_centavos * ci.qty) into v_expected
  from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id
    join public.carts c on c.id = ci.cart_id
  where c.token = v_token;
  select b.code, c.code, c.region_code into v_brgy, v_city, v_region
  from public.psgc_barangays b join public.psgc_cities c on c.code = b.city_code limit 1;
  set local role anon;

  -- Sanity: the fixture really is tampered, or the two assertions below prove
  -- nothing at all.
  perform tests.ok(v_expected > 3::bigint,
    'the live price is far above the tampered snapshot, so the check is meaningful');

  perform tests.eq((public.cart_view(v_token) ->> 'subtotal')::bigint, v_expected,
    'a tampered price snapshot does not change the quote');

  v_addr := jsonb_build_object('regionCode', v_region, 'cityCode', v_city,
                               'barangayCode', v_brgy, 'street', '1 Test St');
  v_order := public.checkout_place_order(v_token, 'Test Buyer', '+639171234567', v_addr, 'cod');
  perform tests.eq((v_order ->> 'subtotal')::bigint, v_expected,
    'and does not change what the order charges');
  perform tests.eq((v_order ->> 'grandTotal')::bigint,
    v_expected + (v_order ->> 'shippingTotal')::bigint + (v_order ->> 'codFee')::bigint,
    'the grand total is its parts, recomputed server-side');

  -- Idempotency: the same token must not produce a second order.
  perform tests.eq(
    public.checkout_place_order(v_token, 'Test Buyer', '+639171234567', v_addr, 'cod') ->> 'orderNumber',
    v_order ->> 'orderNumber',
    'replaying checkout returns the same order rather than making another');

  -- Address validation: present is not the same as real. A region code in the city
  -- field used to be accepted, producing an order no courier could deliver.
  declare v_fresh text; v_v uuid;
  begin
    v_fresh := public.cart_create('rheas-finds');
    select v.id into v_v from public.storefront_variants v
      join public.storefront_products p on p.id = v.product_id
    where p.slug = 'whitening-soap' limit 1;
    perform public.cart_add_item(v_fresh, v_v, 1);
    perform tests.rejects(
      format($q$ select public.checkout_place_order(%L, 'X', '+639171234567',
        jsonb_build_object('regionCode','130000000','cityCode','020000000',
                           'barangayCode','150000000'), 'cod') $q$, v_fresh),
      'a region code in the city field is refused');
    perform tests.rejects(
      format($q$ select public.checkout_place_order(%L, 'X', '09171234567',
        jsonb_build_object('regionCode',%L,'cityCode',%L,'barangayCode',%L), 'cod') $q$,
        v_fresh, v_region, v_city, v_brgy),
      'an unnormalised phone number is refused');
    perform tests.rejects(
      format($q$ select public.checkout_place_order(%L, 'X', '+639171234567',
        jsonb_build_object('regionCode',%L,'cityCode',%L,'barangayCode',%L), 'gcash') $q$,
        v_fresh, v_region, v_city, v_brgy),
      'an online payment method is refused until phase 8 exists');
  end;
end;
$$;

-- The buyer's receipt is reachable by their token, and by nothing else.
do $$
declare v_token text; v_receipt jsonb;
begin
  reset role;
  select c.token into v_token from public.carts c
    join public.orders o on o.cart_id = c.id limit 1;
  set local role anon;

  v_receipt := public.order_receipt_for_token(v_token);
  perform tests.ok(v_receipt is not null, 'a buyer reads their receipt with their own token');
  perform tests.ok(v_receipt::text not ilike '%cost%',
    'and the receipt never exposes the seller''s cost');
  perform tests.ok(public.order_receipt_for_token(repeat('b', 64)) is null,
    'a forged token reads no receipt');
end;
$$;

-- Seller side: ordinary member-scoped RLS, and the token is not readable.
reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.ok((select count(*) from public.orders) >= 1, 'Rhea can read her own orders');
  perform tests.eq((select count(*)::int from public.orders where tenant_id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s orders');
  perform tests.ok((select count(*) from public.customers) >= 1, 'Rhea can read her own customers');
  perform tests.eq((select count(*)::int from public.customers where tenant_id = i.marlon_tenant), 0,
    'Rhea cannot read Marlon''s customers');

  -- Column-level: a cart token is a bearer credential. A seller can see the cart
  -- but must not be handed the secret that lets them act as the buyer.
  perform tests.rejects($q$ select token from public.carts limit 1 $q$,
    'even a member cannot select carts.token');
  perform tests.ok((select count(*) from public.carts) >= 1,
    'but can read the rest of the cart row');

  -- An order is a financial record, and the audit trail behind it is append-only.
  --
  -- Asserted with `rejects` rather than `affected`, and the difference is the
  -- gotcha: a write blocked by RLS affects zero rows silently, but a write blocked
  -- by a missing *grant* raises 42501. These two have no DELETE grant and no UPDATE
  -- grant respectively, so they raise — checking for a zero row count here failed
  -- with "permission denied" instead of passing.
  perform tests.rejects(
    format($q$ delete from public.orders where tenant_id = %L $q$, i.rhea_tenant),
    'orders cannot be deleted, only cancelled');
  perform tests.rejects(
    $q$ update public.order_status_history set to_status = 'delivered' $q$,
    'order status history cannot be rewritten');

  perform tests.ok((select count(*) from public.integration_logs) >= 0,
    'a member can read integration logs');
end;
$$;

select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.orders), 0,
    'Marlon sees none of Rhea''s orders');
  perform tests.eq((select count(*)::int from public.cart_items), 0,
    'and none of her cart items');
end;
$$;

select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 7: shipping zones, rates and the resolver
-- ---------------------------------------------------------------------------
-- Two things are being defended here, and they fail in different ways.
--
-- The first is ordinary tenancy: a zone layout is a seller's commercial
-- arrangement — which places they will ship to and for how much — so it is
-- member-readable, admin-writable, and invisible across tenants.
--
-- The second is *resolution correctness*, which is not a security property but is
-- the thing the phase exists for. `resolve_shipping_zone` picks the most specific
-- match, and if that ordering breaks, nothing errors: every buyer in Davao City is
-- quietly charged the Mindanao rate instead of the city rate the seller set. So
-- the specificity ladder is asserted here rather than left to the UI.
\echo ''
\echo '=== Phase 7: shipping'

reset role;

-- The fixture: exactly the sentence in the phase's done-when, expressed as data.
--   Davao City   -> P80    (city,     specificity 3)
--   Mindanao     -> P150   (region,   specificity 1) — Davao Region is one of them
--   Rest of PH   -> P200   (fallback, specificity 0), free over P2,000
-- Davao City sits *inside* Davao Region on purpose: that overlap is what the
-- ordering has to resolve, and a fixture without it would pass either way.
--
-- `sort_order` runs *backwards* on purpose, and this is load-bearing. It is only a
-- tiebreak between equally specific zones, so the fixture makes it disagree with
-- specificity: the catch-all sorts first and the city zone last. An earlier version
-- numbered them 0/1/2 in specificity order, which meant `order by sort_order` alone
-- produced the same answers — every assertion below passed against a resolver with
-- the specificity tiebreak deleted. Sabotaging the resolver now fails four of them.
do $$
declare
  i record;
  v_davao_zone uuid;
  v_mindanao_zone uuid;
  v_rest_zone uuid;
begin
  select * into i from tests.ids;

  insert into public.shipping_zones (tenant_id, name, is_default, sort_order)
  values (i.rhea_tenant, 'Davao City', false, 9) returning id into v_davao_zone;
  insert into public.shipping_zones (tenant_id, name, is_default, sort_order)
  values (i.rhea_tenant, 'Mindanao', false, 5) returning id into v_mindanao_zone;
  insert into public.shipping_zones (tenant_id, name, is_default, sort_order)
  values (i.rhea_tenant, 'Rest of PH', true, 0) returning id into v_rest_zone;

  insert into public.shipping_zone_areas (tenant_id, zone_id, level, city_code)
  values (i.rhea_tenant, v_davao_zone, 'city', '112402000');
  insert into public.shipping_zone_areas (tenant_id, zone_id, level, region_code)
  values (i.rhea_tenant, v_mindanao_zone, 'region', '110000000'),
         (i.rhea_tenant, v_mindanao_zone, 'region', '100000000');

  insert into public.shipping_rates (tenant_id, zone_id, name, rate_type, flat_centavos)
  values (i.rhea_tenant, v_davao_zone, 'Standard', 'flat', 8000),
         (i.rhea_tenant, v_mindanao_zone, 'Standard', 'flat', 15000);
  insert into public.shipping_rates
    (tenant_id, zone_id, name, rate_type, flat_centavos, free_over_centavos)
  values (i.rhea_tenant, v_rest_zone, 'Standard', 'flat', 20000, 200000);

  -- Marlon gets his own configuration, deliberately covering the SAME city, to
  -- prove the per-tenant uniqueness is per *tenant* and not global.
  insert into public.shipping_zones (tenant_id, name, is_default)
  values (i.marlon_tenant, 'Everywhere', true) returning id into v_rest_zone;
  insert into public.shipping_zone_areas (tenant_id, zone_id, level, city_code)
  values (i.marlon_tenant, v_rest_zone, 'city', '112402000');
  insert into public.shipping_rates (tenant_id, zone_id, name, rate_type, flat_centavos)
  values (i.marlon_tenant, v_rest_zone, 'Standard', 'flat', 9900);

  perform tests.pass('phase 7 fixture: three zones for Rhea, one for Marlon');
end;
$$;

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---- The specificity ladder ------------------------------------------------
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- City beats the region it sits in. This is the assertion the whole phase turns
  -- on: Davao City is inside Davao Region, and both have a zone.
  perform tests.eq(
    (select name from public.shipping_zones
      where id = public.resolve_shipping_zone(
        i.rhea_tenant, '110000000', '112400000', '112402000')),
    'Davao City',
    'a city rule beats the region rule that also covers it');

  -- A different city in the same region falls back to the region rule.
  perform tests.eq(
    (select name from public.shipping_zones
      where id = public.resolve_shipping_zone(
        i.rhea_tenant, '110000000', '112400000', '112401000')),
    'Mindanao',
    'another city in Davao Region resolves to the region zone');

  -- Somewhere in no listed area at all gets the fallback.
  perform tests.eq(
    (select name from public.shipping_zones
      where id = public.resolve_shipping_zone(
        i.rhea_tenant, '070000000', '072200000', '072217000')),
    'Rest of PH',
    'Cebu City is in no listed area and resolves to the fallback');

  -- NCR has no province. A resolver that assumed three levels of code would
  -- return nothing here rather than the fallback, and the buyer could not check
  -- out at all — see the PSGC note in CLAUDE.md.
  perform tests.eq(
    (select name from public.shipping_zones
      where id = public.resolve_shipping_zone(
        i.rhea_tenant, '130000000', null, '137404000')),
    'Rest of PH',
    'an NCR address with a null province still resolves');
end;
$$;

-- ---- What it charges -------------------------------------------------------
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '110000000', '112400000', '112402000', 50000, 500)
      ->> 'amount')::bigint,
    8000::bigint, 'Davao City is quoted P80');
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '100000000', '104300000', '104305000', 50000, 500)
      ->> 'amount')::bigint,
    15000::bigint, 'Northern Mindanao is quoted P150');
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '070000000', '072200000', '072217000', 50000, 500)
      ->> 'amount')::bigint,
    20000::bigint, 'Cebu City falls to the P200 fallback');

  -- The free-over threshold is a modifier on the rate, not a fourth zone.
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '070000000', '072200000', '072217000', 200000, 500)
      ->> 'amount')::bigint,
    0::bigint, 'the fallback ships free at exactly P2,000');
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '070000000', '072200000', '072217000', 199999, 500)
      ->> 'amount')::bigint,
    20000::bigint, 'and still charges one centavo below the threshold');

  -- Davao City's rate has no threshold of its own, so a big order still pays P80.
  -- Worth pinning: a resolver that inherited the fallback's modifier would give
  -- away shipping the seller never agreed to.
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '110000000', '112400000', '112402000', 500000, 500)
      ->> 'amount')::bigint,
    8000::bigint, 'a zone does not inherit the fallback''s free-shipping threshold');
end;
$$;

-- ---- Cross-tenant isolation ------------------------------------------------
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq((select count(*)::int from public.shipping_zones
    where tenant_id = i.rhea_tenant), 0,
    'Marlon sees none of Rhea''s shipping zones');
  perform tests.eq((select count(*)::int from public.shipping_zone_areas
    where tenant_id = i.rhea_tenant), 0,
    'nor which places she ships to');
  perform tests.eq((select count(*)::int from public.shipping_rates
    where tenant_id = i.rhea_tenant), 0,
    'nor what she charges — a competitor''s pricing is not public');

  -- He does see his own, including the same city Rhea also covers.
  perform tests.eq((select count(*)::int from public.shipping_zones), 1,
    'but he sees his own zone');
  perform tests.eq((select count(*)::int from public.shipping_zone_areas
    where city_code = '112402000'), 1,
    'two tenants may both cover Davao City — uniqueness is per tenant');

  -- Writing into her tenant is a WITH CHECK violation, which raises.
  perform tests.rejects(
    format($q$ insert into public.shipping_zones (tenant_id, name)
               values (%L, 'Hostile zone') $q$, i.rhea_tenant),
    'Marlon cannot create a zone in Rhea''s tenant');

  -- And her rows are not reachable to change or remove. Blocked by RLS, so this
  -- affects zero rows rather than raising — the distinction that bit phase 6.
  perform tests.eq(
    tests.affected(format($q$ update public.shipping_rates set flat_centavos = 1
                              where tenant_id = %L $q$, i.rhea_tenant)),
    0::bigint, 'and cannot reprice her shipping');
  perform tests.eq(
    tests.affected(format($q$ delete from public.shipping_zones
                              where tenant_id = %L $q$, i.rhea_tenant)),
    0::bigint, 'and cannot delete her zones');

  -- The resolver is tenant-scoped too: asking it about her tenant must not leak
  -- a zone id, even though the function is SECURITY DEFINER.
  perform tests.ok(
    public.resolve_shipping_zone(i.rhea_tenant, '110000000', '112400000', '112402000') is null,
    'the resolver returns nothing for a tenant the caller is not a member of');
end;
$$;

-- ---- Role enforcement ------------------------------------------------------
-- A packer needs to know what shipping costs to print a label. Deciding what it
-- costs is a different job, and the policies say so.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq((select count(*)::int from public.shipping_zones), 3,
    'a packer reads the shipping configuration');
  perform tests.eq((select count(*)::int from public.shipping_rates), 3,
    'including the rates, which she needs to quote a buyer');

  perform tests.rejects(
    format($q$ insert into public.shipping_zones (tenant_id, name)
               values (%L, 'Packer zone') $q$, i.rhea_tenant),
    'but a packer cannot create a zone');
  perform tests.eq(
    tests.affected($q$ update public.shipping_rates set flat_centavos = 1 $q$),
    0::bigint, 'nor change what shipping costs');
  perform tests.eq(
    tests.affected($q$ delete from public.shipping_zone_areas $q$),
    0::bigint, 'nor change where the store ships to');
end;
$$;

-- ---- Schema guards ---------------------------------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  v_zone uuid;
  v_marlon_zone uuid;
begin
  select * into i from tests.ids;
  select id into v_zone from public.shipping_zones where name = 'Davao City';

  -- One fallback per tenant. Two would make "which rate applies" a coin toss
  -- decided by row order.
  perform tests.rejects(
    format($q$ insert into public.shipping_zones (tenant_id, name, is_default)
               values (%L, 'Second fallback', true) $q$, i.rhea_tenant),
    'a tenant cannot have two fallback zones');

  -- The level must agree with which code column is populated. Without this a row
  -- could claim level 'city' while carrying only a region code, and would then
  -- match at specificity 3 for an entire region.
  perform tests.rejects(
    format($q$ insert into public.shipping_zone_areas
                 (tenant_id, zone_id, level, region_code)
               values (%L, %L, 'city', '110000000') $q$, i.rhea_tenant, v_zone),
    'an area''s level must match the code column it fills');

  -- A place code that is not in PSGC is rejected at write time. This is the whole
  -- reason zone areas are columns with real foreign keys instead of the spec's
  -- match_rules JSONB: phase 6 shipped a JSONB address that happily accepted a
  -- region code in the city field, because JSONB has no foreign keys.
  perform tests.rejects(
    format($q$ insert into public.shipping_zone_areas
                 (tenant_id, zone_id, level, city_code)
               values (%L, %L, 'city', '999999999') $q$, i.rhea_tenant, v_zone),
    'a city code that is not in PSGC is rejected');

  -- The same place twice in one tenant is ambiguous, whether or not it is the
  -- same zone.
  perform tests.rejects(
    format($q$ insert into public.shipping_zone_areas
                 (tenant_id, zone_id, level, city_code)
               values (%L, %L, 'city', '112402000') $q$, i.rhea_tenant, v_zone),
    'the same city cannot be listed twice in one tenant');

  -- A flat rate with no amount would resolve to a null quote at checkout.
  perform tests.rejects(
    format($q$ insert into public.shipping_rates
                 (tenant_id, zone_id, name, rate_type, flat_centavos)
               values (%L, %L, 'Broken', 'flat', null) $q$, i.rhea_tenant, v_zone),
    'a flat rate must carry an amount');

  -- The composite FK, not a trigger: give the parent `unique (tenant_id, id)` and
  -- a cross-tenant child becomes unrepresentable rather than merely forbidden.
  reset role;
  select id into v_marlon_zone from public.shipping_zones where tenant_id = i.marlon_tenant;
  set local role authenticated;
  perform tests.rejects(
    format($q$ insert into public.shipping_zone_areas
                 (tenant_id, zone_id, level, city_code)
               values (%L, %L, 'city', '072217000') $q$, i.rhea_tenant, v_marlon_zone),
    'a zone area cannot point at another tenant''s zone');
end;
$$;

-- ---- Weight bands ----------------------------------------------------------
do $$
declare
  i record;
  v_zone uuid;
  v_rate uuid;
begin
  select * into i from tests.ids;
  select id into v_zone from public.shipping_zones where name = 'Mindanao';

  insert into public.shipping_rates (tenant_id, zone_id, name, rate_type, sort_order)
  values (i.rhea_tenant, v_zone, 'By weight', 'weight_tiered', 1)
  returning id into v_rate;

  -- The heaviest band is open-ended (`up_to_grams` null) so nothing is unpriced.
  insert into public.shipping_weight_tiers (tenant_id, rate_id, up_to_grams, price_centavos)
  values (i.rhea_tenant, v_rate, 1000, 12000),
         (i.rhea_tenant, v_rate, 3000, 18000),
         (i.rhea_tenant, v_rate, null, 25000);

  perform tests.rejects(
    format($q$ insert into public.shipping_weight_tiers
                 (tenant_id, rate_id, up_to_grams, price_centavos)
               values (%L, %L, null, 30000) $q$, i.rhea_tenant, v_rate),
    'a rate cannot have two open-ended top bands');

  -- Deactivate the flat rate so the tiered one is the rate in play.
  update public.shipping_rates set is_active = false
    where zone_id = v_zone and rate_type = 'flat';

  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '100000000', '104300000', '104305000', 50000, 900)
      ->> 'amount')::bigint,
    12000::bigint, 'a 900g parcel falls in the first weight band');
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '100000000', '104300000', '104305000', 50000, 2500)
      ->> 'amount')::bigint,
    18000::bigint, 'a 2.5kg parcel falls in the middle band');
  perform tests.eq(
    (public.quote_shipping(i.rhea_tenant, '100000000', '104300000', '104305000', 50000, 40000)
      ->> 'amount')::bigint,
    25000::bigint, 'and a 40kg parcel falls in the open-ended band, not off the end');
end;
$$;

-- ---- The buyer's side ------------------------------------------------------
-- A zone layout is the seller's commercial arrangement. A buyer gets one resolved
-- number through the cart functions and must not be able to enumerate the rest —
-- including, in particular, what other areas cost.
select tests.logout();
set local role anon;
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.rejects($q$ select count(*) from public.shipping_zones $q$,
    'anon has no grant on shipping_zones');
  perform tests.rejects($q$ select count(*) from public.shipping_zone_areas $q$,
    'anon has no grant on shipping_zone_areas');
  perform tests.rejects($q$ select count(*) from public.shipping_rates $q$,
    'anon has no grant on shipping_rates');
  perform tests.rejects($q$ select count(*) from public.shipping_weight_tiers $q$,
    'anon has no grant on shipping_weight_tiers');

  perform tests.rejects(
    format($q$ select public.resolve_shipping_zone(%L, '110000000', '112400000', '112402000') $q$,
      i.rhea_tenant),
    'and cannot call the resolver directly');
  perform tests.rejects(
    format($q$ select public.quote_shipping(%L, '110000000', '112400000', '112402000', 50000, 500) $q$,
      i.rhea_tenant),
    'nor price an arbitrary address');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- my_tenants()
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== my_tenants()'

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;
  perform tests.eq((select count(*)::int from public.my_tenants()), 1,
    'my_tenants() returns only the caller''s tenants');
  perform tests.eq((select id from public.my_tenants()), i.rhea_tenant,
    'and it is the right one');
end;
$$;

select tests.login('44444444-4444-4444-4444-444444444444', 'nica@example.ph');
do $$
begin
  perform tests.eq((select count(*)::int from public.my_tenants()), 1,
    'a user who joined via invitation sees that tenant in my_tenants()');
end;
$$;

reset role;

-- Report the assertion count, and fail loudly if the file somehow ran with far
-- fewer checks than expected (e.g. a section silently skipped).
do $$
declare v_passed int := coalesce(nullif(current_setting('tests.passed', true), '')::int, 0);
begin
  raise notice '';
  raise notice '=== % assertions passed', v_passed;
  if v_passed < 255 then
    raise exception 'Expected at least 255 assertions, only % ran — did a section get skipped?', v_passed
      using errcode = 'triggered_action_exception';
  end if;
end;
$$;

\echo ''
\echo '=== ALL TENANCY ISOLATION TESTS PASSED'
\echo ''

rollback;
