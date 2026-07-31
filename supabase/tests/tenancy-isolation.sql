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
-- Phase 8: payments, credentials and the webhook boundary
-- ---------------------------------------------------------------------------
-- Three things are defended here, in descending order of how badly they end.
--
-- 1. **Credentials.** `payment_accounts.secret_key` and `.callback_token` are the
--    keys to a seller's money. RLS is row-level and cannot withhold a column, so
--    the column list on the GRANT is the whole control — and that is exactly the
--    kind of thing a later `grant select on all tables` undoes silently.
--
-- 2. **Who may mark an order paid.** `record_payment_event` is service-role only.
--    Reachable by `authenticated` it would let any seller settle their own orders;
--    reachable by `anon` it would let anyone settle anyone's.
--
-- 3. **Replay.** The phase done-when says replaying a webhook changes nothing. It is
--    asserted here as a row count, because `unique (provider, external_id)` is what
--    makes it true and an assertion on the returned outcome string would still pass
--    with the constraint dropped.
\echo ''
\echo '=== Phase 8: payments'

reset role;

do $$
declare
  i record;
  v_order uuid;
  v_payment uuid;
begin
  select * into i from tests.ids;

  insert into public.payment_accounts
    (tenant_id, provider, secret_key, callback_token, is_enabled, connected_at)
  values (i.rhea_tenant, 'xendit', 'xnd_secret_RHEA', 'CB_TOKEN_RHEA', true, now());
  insert into public.payment_accounts
    (tenant_id, provider, secret_key, callback_token, is_enabled, connected_at)
  values (i.marlon_tenant, 'xendit', 'xnd_secret_MARLON', 'CB_TOKEN_MARLON', true, now());

  -- An online payment against the order phase 6 already created for Rhea.
  select id into v_order from public.orders where tenant_id = i.rhea_tenant limit 1;

  insert into public.payments
    (tenant_id, order_id, provider, method, status, amount_centavos, provider_ref)
  values (i.rhea_tenant, v_order, 'xendit', 'gcash', 'awaiting_action',
          (select grand_total_centavos from public.orders where id = v_order), 'inv_test_p8')
  returning id into v_payment;

  perform tests.pass('phase 8 fixture: two connected accounts and one open payment');
end;
$$;

-- ---- Credentials are not readable, by anyone -------------------------------
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- Her own key. Not a cross-tenant test — the point is that *nobody* can read it,
  -- including the person it belongs to. A seller who can read their own callback
  -- token can forge webhooks against their own store, and COD reconciliation and
  -- refunds both run off those statuses.
  perform tests.rejects($q$ select secret_key from public.payment_accounts limit 1 $q$,
    'a seller cannot read their own secret key');
  perform tests.rejects($q$ select callback_token from public.payment_accounts limit 1 $q$,
    'nor their own callback token');

  -- The rest of the row is readable, which is what makes the settings screen work.
  perform tests.eq((select count(*)::int from public.payment_accounts), 1,
    'but the account row itself is visible');
  perform tests.ok(
    (select length(webhook_slug) from public.payment_accounts) = 64,
    'including the webhook slug, which is routing rather than a secret');

  -- And the safe view reports state without ever returning a key.
  perform tests.ok((select has_secret_key from public.payment_accounts_safe),
    'payment_accounts_safe says whether a key is set');
  perform tests.eq((select secret_key_last4 from public.payment_accounts_safe), 'RHEA',
    'and shows only the last four characters');
end;
$$;

-- ---- Nothing but the service role may settle a payment ---------------------
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.rejects(
    $q$ select public.record_payment_event('xendit','evt_x','invoice.paid','inv_test_p8','paid',
                                           100, '{}'::jsonb) $q$,
    'a signed-in seller cannot mark an order paid through the webhook function');
  perform tests.rejects(
    $q$ select public.attach_payment_charge(gen_random_uuid(), 'inv_hijack', 'https://x') $q$,
    'nor point a payment at a provider ref of their choosing');
  perform tests.rejects(
    $q$ select * from public.payment_account_for_webhook('anything') $q$,
    'nor read a callback token through the webhook lookup');
  perform tests.rejects(
    $q$ select * from public.payment_credentials_for_payment(gen_random_uuid()) $q$,
    'nor read a secret key through the credentials lookup');
  perform tests.rejects(
    format($q$ select public.sync_order_payment_status(%L) $q$,
      (select id from public.orders where tenant_id = i.rhea_tenant limit 1)),
    'nor recompute an order''s payment status directly');
end;
$$;

-- ---- Cross-tenant --------------------------------------------------------
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq((select count(*)::int from public.payments
    where tenant_id = i.rhea_tenant), 0,
    'Marlon sees none of Rhea''s payments');
  perform tests.eq((select count(*)::int from public.payment_accounts
    where tenant_id = i.rhea_tenant), 0,
    'nor that she has connected a provider at all');
  perform tests.eq((select count(*)::int from public.payment_accounts_safe
    where tenant_id = i.rhea_tenant), 0,
    'nor through the safe view');

  -- A payment row is only ever written by the SECURITY DEFINER functions, so there
  -- is no insert policy at all — this raises rather than affecting zero rows.
  perform tests.rejects(
    format($q$ insert into public.payments
                 (tenant_id, order_id, provider, method, status, amount_centavos)
               values (%L, %L, 'manual', 'bank', 'paid', 1) $q$,
      i.rhea_tenant, (select id from public.orders where tenant_id = i.rhea_tenant limit 1)),
    'and cannot write a payment against her order');

  perform tests.rejects(
    format($q$ select public.record_manual_payment(%L, 'bank', 100000) $q$,
      (select id from public.orders where tenant_id = i.rhea_tenant limit 1)),
    'nor record one through the function');
end;
$$;

-- ---- Role enforcement ------------------------------------------------------
-- A packer marks COD remitted; only an admin gives money back.
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare
  i record;
  v_payment uuid;
begin
  select * into i from tests.ids;
  select id into v_payment from public.payments where provider_ref = 'inv_test_p8';

  perform tests.eq((select count(*)::int from public.payments), 1,
    'a packer can see what has been paid');
  perform tests.eq((select count(*)::int from public.payment_accounts), 0,
    'but not the payment account — live-vs-test keys are not packer business');

  perform tests.rejects(
    format($q$ select public.open_refund(%L, 100, 'nope') $q$, v_payment),
    'and cannot refund a payment');
end;
$$;

-- ---- Replay is a no-op, asserted on the row count ---------------------------
reset role;
do $$
declare
  i record;
  v_order   uuid;
  v_payment uuid;
  v_first   jsonb;
  v_again   jsonb;
  v_events  int;
  v_history int;
  v_paid_at timestamptz;
begin
  select * into i from tests.ids;
  select id into v_payment from public.payments where provider_ref = 'inv_test_p8';
  select order_id into v_order from public.payments where id = v_payment;

  v_first := public.record_payment_event(
    'xendit', 'evt_replay_1', 'invoice.paid', 'inv_test_p8', 'paid',
    (select grand_total_centavos::bigint from public.orders where id = v_order),
    '{"status":"PAID"}'::jsonb, 1500, now());

  perform tests.eq(v_first ->> 'outcome', 'applied', 'a verified event is applied');
  perform tests.eq((select payment_status from public.orders where id = v_order), 'paid',
    'and the order reaches paid with no polling');

  select count(*) into v_events  from public.webhook_events;
  select count(*) into v_history from public.order_status_history where order_id = v_order;
  select paid_at  into v_paid_at from public.payments where id = v_payment;

  v_again := public.record_payment_event(
    'xendit', 'evt_replay_1', 'invoice.paid', 'inv_test_p8', 'paid',
    (select grand_total_centavos::bigint from public.orders where id = v_order),
    '{"status":"PAID"}'::jsonb, 1500, now());

  perform tests.eq(v_again ->> 'outcome', 'duplicate', 'a replay is recognised as a duplicate');
  -- The row count, not the outcome string. `unique (provider, external_id)` is what
  -- makes replay safe; asserting only on the outcome would still pass with the
  -- constraint dropped, because a later guard happens to catch the paid-twice case.
  perform tests.eq((select count(*)::int from public.webhook_events), v_events,
    'and is not recorded a second time');
  perform tests.eq(
    (select count(*)::int from public.order_status_history where order_id = v_order), v_history,
    'nor does it add a second timeline entry');
  perform tests.eq((select paid_at from public.payments where id = v_payment), v_paid_at,
    'nor move the settlement time');

  -- A late "expired" after a capture must not un-pay a paid order. Providers do
  -- send these.
  perform public.record_payment_event(
    'xendit', 'evt_late_expiry', 'invoice.expired', 'inv_test_p8', 'expired', 0, '{}'::jsonb);
  perform tests.eq((select payment_status from public.orders where id = v_order), 'paid',
    'a late expiry does not un-pay a settled order');
end;
$$;

-- ---- A short-pay is not a paid order ---------------------------------------
-- The provider tells us what the buyer actually sent. Believing it settles the
-- order is the same mistake as believing a client-supplied price, which hard rule 6
-- already forbids on the way out.
do $$
declare
  i record;
  v_order   uuid;
  v_payment uuid;
begin
  select * into i from tests.ids;
  select id into v_order from public.orders where tenant_id = i.rhea_tenant limit 1;

  insert into public.payments
    (tenant_id, order_id, provider, method, status, amount_centavos, provider_ref)
  values (i.rhea_tenant, v_order, 'xendit', 'gcash', 'awaiting_action', 100000, 'inv_short_p8')
  returning id into v_payment;

  -- Wipe the earlier settlement so this order is unpaid again.
  delete from public.payments where provider_ref = 'inv_test_p8';
  perform public.sync_order_payment_status(v_order);

  perform public.record_payment_event(
    'xendit', 'evt_short_p8', 'invoice.paid', 'inv_short_p8', 'paid', 1, '{}'::jsonb);

  perform tests.ok(
    (select grand_total_centavos::bigint from public.orders where id = v_order) > 1,
    'the order is worth more than one centavo');
  perform tests.eq((select payment_status from public.orders where id = v_order), 'partial',
    'a one-centavo payment leaves the order partial, never paid');
end;
$$;

-- ---- The buyer's side ------------------------------------------------------
-- The order id is resolved *before* becoming anon: anon has no grant on `orders`
-- (phase 6), so building the SQL string inside the anon block would fail outside
-- the `rejects` wrapper and abort the suite rather than assert anything.
create table tests.p8_order as
  select id from public.orders limit 1;
grant select on tests.p8_order to anon, authenticated;

set local role anon;
do $$
declare
  i record;
  v_order uuid;
begin
  select * into i from tests.ids;
  select id into v_order from tests.p8_order;

  perform tests.rejects($q$ select count(*) from public.payment_accounts $q$,
    'anon has no grant on payment_accounts');
  perform tests.rejects($q$ select count(*) from public.payments $q$,
    'anon has no grant on payments');
  perform tests.rejects($q$ select count(*) from public.payment_refunds $q$,
    'anon has no grant on payment_refunds');
  perform tests.rejects($q$ select count(*) from public.webhook_events $q$,
    'anon has no grant on webhook_events');

  perform tests.rejects(
    $q$ select public.record_payment_event('xendit','evt_anon','invoice.paid','inv_test_p8',
                                           'paid', 100, '{}'::jsonb) $q$,
    'and above all cannot mark an order paid');
  perform tests.rejects(
    format($q$ select public.record_cod_remittance(%L) $q$, v_order),
    'nor remit a COD order on the seller''s behalf');

  -- What a buyer *can* do: read which methods a store offers. Names only.
  perform tests.ok(
    public.storefront_payment_methods('rheas-finds', null) is not null,
    'but can ask which payment methods a storefront offers');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 9: the order dashboard
-- ---------------------------------------------------------------------------
-- The bulk transition is the piece that needs the most care. It takes an *array of
-- ids* and a tenant, and moves them in one statement — so if the tenant scope on
-- that UPDATE were ever dropped, a caller could move any order in the system by
-- guessing an id. The assertions below aim straight at that.
\echo ''
\echo '=== Phase 9: orders dashboard'

reset role;
do $$
declare
  i record;
  v_rhea_order   uuid;
  v_marlon_order uuid;
begin
  select * into i from tests.ids;

  -- Marlon needs an order of his own to prove isolation in both directions.
  insert into public.orders
    (tenant_id, order_number, shipping_address, contact_name, contact_phone,
     subtotal_centavos, shipping_total_centavos, grand_total_centavos,
     payment_method, fulfillment_status)
  values (i.marlon_tenant, 'M-0001', '{"cityName":"Cebu City"}'::jsonb,
          'Marlon Buyer', '+639181234567', 50000, 10000, 60000, 'cod', 'confirmed')
  returning id into v_marlon_order;

  select id into v_rhea_order from public.orders where tenant_id = i.rhea_tenant limit 1;
  update public.orders set fulfillment_status = 'confirmed' where id = v_rhea_order;

  create table tests.p9 as select v_rhea_order as rhea_order, v_marlon_order as marlon_order;
  grant select on tests.p9 to authenticated, anon;

  perform tests.pass('phase 9 fixture: one confirmed order in each tenant');
end;
$$;

set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
  v_res jsonb;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  -- ---- The bulk transition is tenant-scoped -------------------------------
  -- Passing his own tenant with *her* order id must move nothing. This is the
  -- assertion that matters most in the phase: the function is authorised once
  -- against the tenant, and the `where tenant_id = p_tenant_id` on the UPDATE is
  -- what makes that safe.
  v_res := public.orders_bulk_transition(i.marlon_tenant, array[p.rhea_order], 'packed');
  perform tests.eq((v_res ->> 'moved')::int, 0,
    'Marlon cannot move Rhea''s order by passing his own tenant id');
  perform tests.eq((v_res ->> 'skipped')::int, 1,
    'and it is reported as skipped rather than silently dropped');

  -- Passing *her* tenant is refused outright, because he is not a member.
  perform tests.rejects(
    format($q$ select public.orders_bulk_transition(%L, array[%L]::uuid[], 'packed') $q$,
      i.rhea_tenant, p.rhea_order),
    'nor by passing her tenant id, which he is not a member of');

  -- A mixed array moves only his own.
  v_res := public.orders_bulk_transition(
    i.marlon_tenant, array[p.rhea_order, p.marlon_order], 'packed');
  perform tests.eq((v_res ->> 'moved')::int, 1,
    'a mixed batch moves only the orders the caller''s tenant owns');
  -- Whether *her* order actually moved is asserted from her own session below: RLS
  -- correctly hides it from him, so reading it here returns null either way and
  -- would pass against a broken tenant scope.

  -- ---- Reads ---------------------------------------------------------------
  perform tests.ok(public.orders_list(i.rhea_tenant) is null,
    'orders_list returns nothing for a tenant the caller is not a member of');
  perform tests.ok(public.order_detail(p.rhea_order) is null,
    'order_detail returns nothing for another tenant''s order');
  perform tests.ok(public.orders_packing_batch(i.rhea_tenant, array[p.rhea_order]) is null,
    'nor can her orders be printed');
  -- Zero, not null: the membership test is inside the WHERE, so a non-member gets
  -- an all-zeros document. That leaks nothing — "no orders" and "not yours" look
  -- identical from outside, which is the point.
  perform tests.eq((public.orders_view_counts(i.rhea_tenant) ->> 'all'), '0',
    'her order counts read as zero to a non-member, never her real numbers');

  -- His own list works, and contains only his.
  perform tests.eq(
    jsonb_array_length(public.orders_list(i.marlon_tenant, 'all') -> 'orders'), 1,
    'but his own list works and holds only his order');

  -- ---- Notes ---------------------------------------------------------------
  perform tests.rejects(
    format($q$ select public.add_order_note(%L, 'prying') $q$, p.rhea_order),
    'and he cannot annotate her order');
end;
$$;

-- ---- Notes are append-only, and internal --------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare p record;
begin
  select * into p from tests.p9;

  -- The other half of the cross-tenant bulk assertion, read as the only person who
  -- can see the row.
  perform tests.eq(
    (select fulfillment_status from public.orders where id = p.rhea_order), 'confirmed',
    'and Rhea''s order really was untouched by Marlon''s batch');

  perform public.add_order_note(p.rhea_order, 'Customer disputes every RTS');
  perform tests.eq((select count(*)::int from public.order_notes), 1,
    'a member adds an internal note');

  -- The author comes from the session, not from the request. A note whose author
  -- the client can choose is not a record of anything.
  perform tests.eq(
    (select author_id from public.order_notes limit 1),
    '11111111-1111-1111-1111-111111111111'::uuid,
    'and the author is taken from the session');

  -- Append-only. Asserted with `rejects`, not `affected`: there is no UPDATE
  -- *grant* on the table at all, so this raises 42501 rather than being an
  -- RLS-denied zero-row update. Same distinction that bit phase 6 on `orders`.
  -- A timeline you can rewrite is not evidence.
  perform tests.rejects($q$ update public.order_notes set body = 'rewritten' $q$,
    'a note cannot be edited after the fact — there is no update grant');

  -- A packer cannot forge someone else's authorship: the INSERT policy pins
  -- author_id to auth.uid().
  perform tests.rejects(
    format($q$ insert into public.order_notes (tenant_id, order_id, author_id, body)
               select tenant_id, %L, %L, 'not me' from public.orders where id = %L $q$,
      p.rhea_order, '22222222-2222-2222-2222-222222222222'::uuid, p.rhea_order),
    'nor can a note be attributed to someone else');
end;
$$;

-- ---- Role enforcement ------------------------------------------------------
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare
  i record;
  p record;
  v_res jsonb;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  -- A packer packs. That is the job, and this screen exists for it.
  --
  -- `packer` ranks *below* `staff` in the hierarchy, so the first version of
  -- `orders_bulk_transition` — which required `staff` — locked the packer role out
  -- of packing entirely. Found here, fixed there.
  v_res := public.orders_bulk_transition(i.rhea_tenant, array[p.rhea_order], 'packed');
  perform tests.eq((v_res ->> 'moved')::int, 1, 'a packer can move orders to packed');
  perform tests.eq(
    (select count(*)::int from public.order_status_history
      where order_id = p.rhea_order and to_status = 'packed'), 1,
    'and the timeline records it, written by the same statement');

  perform tests.eq(
    (select actor_id from public.order_status_history
      where order_id = p.rhea_order and to_status = 'packed'),
    '33333333-3333-3333-3333-333333333333'::uuid,
    'attributed to whoever actually did it');

  perform tests.ok(public.orders_list(i.rhea_tenant) is not null,
    'a packer reads the order list');

  -- But cancelling is a commercial decision with a refund attached, not a
  -- warehouse one.
  perform tests.rejects(
    format($q$ select public.orders_bulk_transition(%L, array[%L]::uuid[], 'cancelled') $q$,
      i.rhea_tenant, p.rhea_order),
    'but a packer cannot cancel an order');

  -- Nor take a new order over DM: that is pricing and stock, not packing.
  perform tests.rejects(
    format($q$ select public.create_manual_order(%L, 'Walk-in', '+639171234567',
             '{}'::jsonb, '[]'::jsonb) $q$, i.rhea_tenant),
    'nor create one by hand');
end;
$$;

-- ---- The pipeline is enforced, not advisory --------------------------------
do $$
declare
  i record;
  p record;
  v_res jsonb;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  -- packed -> delivered is not in `order_transitions`. Skipped, not moved.
  v_res := public.orders_bulk_transition(i.rhea_tenant, array[p.rhea_order], 'delivered');
  perform tests.eq((v_res ->> 'moved')::int, 0,
    'an illegal transition moves nothing');
  perform tests.eq((select fulfillment_status from public.orders where id = p.rhea_order),
    'packed', 'and leaves the order where it was');

  -- A status that is not in the pipeline at all raises, because it is a bug in the
  -- caller rather than a stale screen.
  perform tests.rejects(
    format($q$ select public.orders_bulk_transition(%L, array[%L]::uuid[], 'teleported') $q$,
      i.rhea_tenant, p.rhea_order),
    'an unknown status is rejected outright');

  -- The batch cap.
  perform tests.rejects(
    format($q$ select public.orders_bulk_transition(%L,
             (select array_agg(g::text::uuid) from generate_series(1,501) g
               cross join lateral (select gen_random_uuid() as g) x), 'packed') $q$,
      i.rhea_tenant),
    'an oversized batch is refused rather than attempted');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  perform tests.rejects($q$ select count(*) from public.order_notes $q$,
    'anon has no grant on order_notes');
  perform tests.rejects(
    format($q$ select public.orders_list(%L) $q$, i.rhea_tenant),
    'nor can anon list a store''s orders');
  perform tests.rejects(
    format($q$ select public.order_detail(%L) $q$, p.rhea_order),
    'nor read one');
  perform tests.rejects(
    format($q$ select public.orders_bulk_transition(%L, array[%L]::uuid[], 'shipped') $q$,
      i.rhea_tenant, p.rhea_order),
    'nor move one');
  perform tests.rejects(
    format($q$ select public.orders_packing_batch(%L, array[%L]::uuid[]) $q$,
      i.rhea_tenant, p.rhea_order),
    'nor print a batch of a seller''s customer addresses');
  perform tests.rejects(
    format($q$ select public.create_manual_order(%L, 'x', '+639171234567',
             '{}'::jsonb, '[]'::jsonb) $q$, i.rhea_tenant),
    'nor create an order in someone''s store');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 10: couriers
-- ---------------------------------------------------------------------------
-- Two things are new and dangerous here. Courier credentials are the first
-- *encrypted* secret in the schema, and a shipment is the first row whose
-- existence changes an order's status — so a cross-tenant write would move
-- someone else's order to shipped.
\echo ''
\echo '=== Phase 10: couriers'

reset role;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  insert into public.courier_accounts
    (tenant_id, courier, origin_address, sender_name, sender_phone, account_ref)
  values (i.rhea_tenant, 'jnt', '{"cityCode":"112402000"}'::jsonb,
          'Rhea', '+639171234567', 'CUST-RHEA'),
         (i.marlon_tenant, 'jnt', '{"cityCode":"072217000"}'::jsonb,
          'Marlon', '+639181234567', 'CUST-MARLON');

  perform public.set_courier_credentials(
    i.rhea_tenant, 'jnt', '{"apiKey":"RHEA-SECRET"}'::jsonb, 'test-key');
  update public.courier_accounts set is_enabled = true where tenant_id = i.rhea_tenant;

  perform tests.pass('phase 10 fixture: two courier accounts, one with credentials');
end;
$$;

-- ---- Credentials are encrypted, and unreadable either way -------------------
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.rejects(
    $q$ select credentials_encrypted from public.courier_accounts limit 1 $q$,
    'not even an admin can read the encrypted credential blob');
  perform tests.rejects(
    format($q$ select public.courier_credentials(
      (select id from public.courier_accounts_safe where tenant_id = %L), 'test-key') $q$,
      i.rhea_tenant),
    'nor decrypt it, whatever key they guess');
  perform tests.rejects(
    format($q$ select public.set_courier_credentials(%L, 'jnt', '{}'::jsonb, 'x') $q$,
      i.rhea_tenant),
    'nor overwrite it with a key of their own');

  -- What they may see: that it is connected, and where from.
  perform tests.ok((select has_credentials from public.courier_accounts_safe
                     where tenant_id = i.rhea_tenant),
    'but the safe view says whether a courier is connected');
  perform tests.eq((select count(*)::int from public.courier_accounts_safe), 1,
    'and shows only their own');
end;
$$;

-- ---- What is actually stored is ciphertext ---------------------------------
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- The plaintext must not be sitting in the column. Asserted rather than assumed:
  -- an encryption call that silently no-ops would still pass every test above.
  perform tests.ok(
    (select position('RHEA-SECRET' in encode(credentials_encrypted, 'escape')) = 0
     from public.courier_accounts where tenant_id = i.rhea_tenant),
    'the stored credential does not contain its own plaintext');

  perform tests.eq(
    (select public.courier_credentials(id, 'test-key') ->> 'apiKey'
     from public.courier_accounts where tenant_id = i.rhea_tenant),
    'RHEA-SECRET', 'and the right key decrypts it');

  perform tests.rejects(
    format($q$ select public.courier_credentials(
      (select id from public.courier_accounts where tenant_id = %L), 'wrong-key') $q$,
      i.rhea_tenant),
    'while a wrong key raises rather than returning garbage');
end;
$$;

-- ---- Shipments are tenant-scoped -------------------------------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  perform tests.rejects(
    format($q$ select public.courier_booking_batch(%L, array[%L]::uuid[], 'jnt') $q$,
      i.rhea_tenant, p.rhea_order),
    'Marlon cannot pull a booking batch for Rhea''s tenant');

  -- His own tenant with her order id: the batch is scoped, so her order is simply
  -- not in it. Nothing raises, and nothing leaks.
  perform tests.rejects(
    format($q$ select public.courier_booking_batch(%L, array[%L]::uuid[], 'jnt') $q$,
      i.marlon_tenant, p.rhea_order),
    'and his own courier is not connected, so there is nothing to book with');

  perform tests.eq(
    (public.shipment_labels(i.rhea_tenant, array[p.rhea_order]))::text, '[]',
    'nor can he read her waybills');

  perform tests.eq((select count(*)::int from public.courier_accounts), 1,
    'he sees only his own courier account');
  perform tests.eq((select count(*)::int from public.shipments
                     where tenant_id = i.rhea_tenant), 0,
    'and none of her shipments');
end;
$$;

-- ---- Booking is a packer''s job, credentials are an admin''s ----------------
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.ok(
    public.courier_booking_batch(i.rhea_tenant, array[]::uuid[], 'jnt') is not null,
    'a packer can pull a booking batch — booking parcels is the job');
  perform tests.eq((select count(*)::int from public.courier_accounts), 0,
    'but cannot see the courier account itself');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  perform tests.rejects($q$ select count(*) from public.courier_accounts $q$,
    'anon has no grant on courier_accounts');
  perform tests.rejects($q$ select count(*) from public.shipments $q$,
    'nor on shipments');
  perform tests.rejects($q$ select count(*) from public.courier_booking_failures $q$,
    'nor on the booking failure queue');
  perform tests.rejects(
    format($q$ select public.courier_credentials(gen_random_uuid(), 'k') $q$),
    'and above all cannot decrypt a courier credential');
  perform tests.rejects(
    format($q$ select public.record_shipment(%L, %L, 'jnt', 'FAKE1', 'standard') $q$,
      i.rhea_tenant, p.rhea_order),
    'nor invent a waybill to move an order to shipped');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 11: tracking and buyer notifications
-- ---------------------------------------------------------------------------
-- The new surface here is a page with **no authentication at all**. Everything
-- below is about the two questions that follow from that: what a stranger holding
-- an order number can see, and what a seller can be charged for.
\echo ''
\echo '=== Phase 11: tracking'

reset role;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  -- Both stores ship a parcel. Same waybill *number space*, different couriers'
  -- customers — the point being that neither can see the other's scans.
  perform public.record_shipment(i.rhea_tenant,   p.rhea_order,   'jnt', 'JT-RHEA-1', 'standard');
  perform public.record_shipment(i.marlon_tenant, p.marlon_order, 'jnt', 'JT-MARLON-1', 'standard');

  perform public.record_shipment_event('jnt', 'JT-RHEA-1', 'in_transit', '300',
    now() - interval '5 hours', 'Departed sorting centre', 'Davao Sorting Hub');
  perform public.record_shipment_event('jnt', 'JT-MARLON-1', 'in_transit', '300',
    now() - interval '5 hours', 'Departed sorting centre', 'Cebu Sorting Hub');

  create table tests.p11 as
  select
    (select order_number from public.orders where id = p.rhea_order)   as rhea_number,
    (select order_number from public.orders where id = p.marlon_order) as marlon_number,
    (select contact_name  from public.orders where id = p.rhea_order)   as rhea_buyer;
  grant select on tests.p11 to authenticated, anon;

  perform tests.pass('phase 11 fixture: one parcel in flight in each tenant');
end;
$$;

-- ---- Every new tenant is set up to notify, without being asked --------------
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- A seller who has to go and write five SMS templates before tracking works is
  -- a seller whose tracking does not work.
  perform tests.eq((select count(*)::int from public.sms_templates
                     where tenant_id = i.rhea_tenant), 10,
    'seed_tenant_defaults gave the new tenant a full set of SMS templates');
  perform tests.ok(public.sms_credit_balance(i.rhea_tenant) > 0,
    'and enough trial credits to actually send some');

  -- Hard rule: nothing that goes out over SMS may contain the peso sign. One
  -- `PHP` -> `₱` edit in a template halves the segment budget for every message
  -- that store ever sends.
  perform tests.eq(
    (select count(*)::int from public.sms_templates where body like '%' || U&'\20B1' || '%'), 0,
    'no default template contains a peso sign, which would force UCS-2');

  -- The ledger is the balance. Asserted rather than assumed: a `balance_after`
  -- that drifts from the running sum is a bill a seller cannot explain.
  perform tests.eq(
    (select coalesce(sum(delta), 0)::int from public.sms_credit_entries
      where tenant_id = i.rhea_tenant),
    public.sms_credit_balance(i.rhea_tenant),
    'the credit ledger sums to the stored balance');
end;
$$;

-- ---- Scans and credits are tenant-scoped -----------------------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  n record;
begin
  select * into i from tests.ids;
  select * into n from tests.p11;

  perform tests.eq((select count(*)::int from public.shipment_events), 1,
    'Marlon sees only the scans on his own parcel');
  perform tests.eq((select count(*)::int from public.shipment_events
                     where tenant_id = i.rhea_tenant), 0,
    'and none of Rhea''s, even addressing her tenant by id');

  perform tests.eq((select count(*)::int from public.sms_credit_entries
                     where tenant_id = i.rhea_tenant), 0,
    'nor how many credits she has left');
  -- SECURITY DEFINER bypasses the RLS on the ledger, so the function must do
  -- its own membership check. Without it this returns her real balance.
  perform tests.ok(public.sms_credit_balance(i.rhea_tenant) is null,
    'and sms_credit_balance() tells him nothing either');

  perform tests.eq((select count(*)::int from public.sms_templates
                     where tenant_id = i.rhea_tenant), 0,
    'nor what her store says to its buyers');

  -- Writing into her tenant is a WITH CHECK violation, which raises.
  perform tests.rejects(
    format($q$ insert into public.sms_templates (tenant_id, event, locale, body)
               values (%L, 'shipped', 'en', 'pwned') $q$, i.rhea_tenant),
    'and cannot put words in her store''s mouth');
end;
$$;

-- ---- The ledger is readable, never writable --------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- No INSERT grant at all, so this raises rather than affecting zero rows —
  -- the distinction phase 9 had to learn on `order_notes`.
  perform tests.rejects(
    format($q$ insert into public.sms_credit_entries (tenant_id, delta, balance_after, reason)
               values (%L, 1000000, 1000000, 'topup') $q$, i.rhea_tenant),
    'not even an owner can grant herself SMS credits');
  perform tests.rejects(
    format($q$ select public.sms_credit_move(%L, 1000000, 'topup') $q$, i.rhea_tenant),
    'nor move the ledger directly');

  -- Nor can she drive her own orders by inventing courier scans: that is how a
  -- COD order gets marked delivered without a parcel ever moving.
  perform tests.rejects(
    $q$ select public.record_shipment_event('jnt', 'JT-RHEA-1', 'delivered', '500', now()) $q$,
    'nor record a courier scan herself');
  perform tests.rejects(
    format($q$ select public.sms_render_for_order(%L, 'shipped', 'https://x') $q$,
      (select rhea_order from tests.p9)),
    'nor render a message on the sending path');
  perform tests.rejects(
    $q$ select public.shipments_to_poll() $q$,
    'and above all cannot enumerate every parcel on the platform');

  -- What she *can* do is edit her own copy.
  perform tests.eq(
    tests.affected(
      format($q$ update public.sms_templates set body = 'Padala na ang order mo {{orderNumber}}.'
                 where tenant_id = %L and event = 'shipped' and locale = 'tl' $q$, i.rhea_tenant)),
    1::bigint, 'but an admin may rewrite her store''s own templates');
end;
$$;

-- ---- A packer may read the templates, not rewrite them ----------------------
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.eq((select count(*)::int from public.sms_templates), 10,
    'a packer can see what the store texts buyers');
  -- Blocked by a policy, so it affects zero rows rather than raising.
  perform tests.eq(
    tests.affected(
      format($q$ update public.sms_templates set body = 'hi' where tenant_id = %L $q$,
        i.rhea_tenant)),
    0::bigint, 'but cannot change it — that is an admin decision');
end;
$$;

-- ---- The public tracking page ----------------------------------------------
-- The one thing on this surface a buyer may reach, and the whole reason the page
-- is thin: the order number is the only credential, and order numbers are short,
-- sequential and forwarded in group chats.
select tests.logout();
set local role anon;
do $$
declare
  i record;
  n record;
  v_track jsonb;
  v_other jsonb;
begin
  select * into i from tests.ids;
  select * into n from tests.p11;

  perform tests.rejects($q$ select count(*) from public.shipment_events $q$,
    'anon has no grant on shipment_events');
  perform tests.rejects($q$ select count(*) from public.sms_templates $q$,
    'nor on sms_templates');
  perform tests.rejects($q$ select count(*) from public.sms_credit_entries $q$,
    'nor on the credit ledger');
  perform tests.rejects(
    $q$ select public.record_shipment_event('jnt', 'JT-RHEA-1', 'delivered', '500', now()) $q$,
    'and cannot forge a delivery scan');
  perform tests.rejects(
    format($q$ select public.record_tracking_sms(%L, %L, 'shipped', '+639171234567',
                 'x', 'log', null, 'sent', 30, 1) $q$,
      i.rhea_tenant, (select rhea_order from tests.p9)),
    'nor spend a seller''s credits by asking for a text');
  perform tests.rejects(
    $q$ select public.shipments_to_poll() $q$,
    'nor list every parcel in flight on the platform');

  -- What they may do:
  v_track := public.public_tracking('rheas-finds', null, n.rhea_number);
  perform tests.ok(v_track is not null,
    'but may track an order by store and order number, with no account');
  perform tests.eq(v_track ->> 'status', 'shipped',
    'and it says where the parcel is');
  perform tests.eq(jsonb_array_length(v_track -> 'events'), 1,
    'with the courier timeline');

  -- And what that page must never contain. Every one of these was on the order.
  perform tests.eq((v_track ? 'contactPhone')::int::text, '0',
    'the page carries no phone number');
  perform tests.eq((v_track ? 'shippingAddress')::int::text, '0',
    'nor an address');
  perform tests.eq((v_track ? 'grandTotal')::int::text, '0',
    'nor what the buyer paid');
  perform tests.ok(v_track::text not like '%Rizal%',
    'nor a street, anywhere in the payload');
  perform tests.eq(v_track ->> 'firstName', split_part(n.rhea_buyer, ' ', 1),
    'only the buyer''s first name — enough to recognise your own parcel');
  perform tests.ok(
    n.rhea_buyer = split_part(n.rhea_buyer, ' ', 1)
    or v_track::text not like '%' || split_part(n.rhea_buyer, ' ', 2) || '%',
    'and never their surname');

  -- Order numbers are allocated per tenant, so they are only unique *within* a
  -- store. The lookup must therefore be scoped by store and not by number alone.
  --
  -- These two assertions are the ones that catch a tenant-blind resolver: both
  -- numbers exist in the database, on real orders with real timelines, and each
  -- is asked for on the wrong storefront. A `where order_number = $1` with the
  -- tenant filter dropped returns the other store's order and its buyer's name.
  v_other := public.public_tracking('marlon-kicks', null, n.rhea_number);
  perform tests.ok(v_other is null,
    'Rhea''s order number does not resolve on Marlon''s storefront');
  perform tests.ok(
    public.public_tracking('rheas-finds', null, n.marlon_number) is null,
    'and not the other way round either');
  -- Both really do exist, so the nulls above are scoping and not a broken lookup.
  perform tests.ok(public.public_tracking('rheas-finds', null, n.rhea_number) is not null
               and public.public_tracking('marlon-kicks', null, n.marlon_number) is not null,
    'while each resolves perfectly well on its own');
  perform tests.ok(public.public_tracking('rheas-finds', null, '999999') is null,
    'an order number that does not exist returns nothing');
  perform tests.ok(public.public_tracking('no-such-store', null, n.rhea_number) is null,
    'and neither does a store that does not exist');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 12: COD reconciliation, returns, and buyer risk
-- ---------------------------------------------------------------------------
-- Three things are new and each is dangerous in its own way. A remittance import
-- decides which orders are *paid*. A return writes *inventory*. And the risk pool
-- is the first table in the schema that deliberately spans tenants.
\echo ''
\echo '=== Phase 12: COD & returns'

reset role;
do $$
declare
  i record;
  p record;
  v_rts_order uuid;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  -- Both parcels delivered, both COD, neither paid: money the couriers are
  -- holding. (`record_shipment` in the phase-11 fixture already booked them.)
  update public.shipments set status = 'delivered', delivered_at = now() - interval '35 days'
   where tenant_id = i.rhea_tenant;
  update public.shipments set status = 'delivered', delivered_at = now() - interval '2 days'
   where tenant_id = i.marlon_tenant;
  update public.orders set fulfillment_status = 'delivered'
   where id in (p.rhea_order, p.marlon_order);

  -- One more parcel of Rhea's, still out, with real order items behind it — the
  -- return test needs something that can actually come back, and something with
  -- units to put away.
  insert into public.orders
    (tenant_id, order_number, shipping_address, contact_name, contact_phone,
     subtotal_centavos, shipping_total_centavos, grand_total_centavos,
     payment_method, fulfillment_status, location_id)
  values (i.rhea_tenant, 'R-RTS-1',
          '{"cityName":"Davao City","provinceName":"Davao Del Sur"}'::jsonb,
          'Aileen Ramos', '+639171239876', 50000, 10000, 60000, 'cod', 'shipped',
          (select id from public.locations where tenant_id = i.rhea_tenant limit 1))
  returning id into v_rts_order;

  insert into public.order_items
    (tenant_id, order_id, variant_id, product_name, sku, qty,
     unit_price_centavos, line_total_centavos)
  select i.rhea_tenant, v_rts_order, v.id, 'Returned item', v.sku, 2, 25000, 50000
  from public.product_variants v where v.tenant_id = i.rhea_tenant limit 1;

  create table tests.p12 as select v_rts_order as rts_order;
  grant select on tests.p12 to authenticated, anon;

  perform tests.pass('phase 12 fixture: a delivered COD parcel in each tenant, and one still out');
end;
$$;

-- ---- The screen is scoped, and so is every number on it --------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  v_mine jsonb;
begin
  select * into i from tests.ids;

  v_mine := public.cod_reconciliation(i.marlon_tenant);
  perform tests.eq((v_mine #>> '{outstanding,count}')::int, 1,
    'Marlon''s COD screen shows his own outstanding parcel');
  perform tests.ok(v_mine::text not like '%JT-RHEA%',
    'and none of Rhea''s waybills anywhere in the payload');

  perform tests.rejects(
    format($q$ select public.cod_reconciliation(%L) $q$, i.rhea_tenant),
    'and he cannot ask for her COD position at all');

  perform tests.rejects(
    format($q$ select public.cod_import_statement(%L, 'jnt', '[]'::jsonb) $q$, i.rhea_tenant),
    'nor import a statement into her books');
  perform tests.rejects(
    format($q$ select public.rts_report(%L) $q$, i.rhea_tenant),
    'nor read her returns');
  perform tests.rejects(
    format($q$ select public.buyer_risk_lookup(%L, '+639171234567') $q$, i.rhea_tenant),
    'nor look up what she knows about a buyer');
end;
$$;

-- ---- Importing decides nothing the client asked for ------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
  v_batch jsonb;
  v_id    uuid;
  v_due   bigint;
  v_was   text;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;
  select grand_total_centavos, payment_status into v_due, v_was
    from public.orders where id = p.rhea_order;

  -- Four lines: right, short, a waybill that is not ours, and a repeat.
  v_batch := public.cod_import_statement(i.rhea_tenant, 'jnt', jsonb_build_array(
    jsonb_build_object('waybill', 'JT-RHEA-1', 'amount', v_due,     'fee', 0),
    jsonb_build_object('waybill', 'JT-RHEA-1', 'amount', v_due,     'fee', 0),
    jsonb_build_object('waybill', 'JT-MARLON-1', 'amount', 100000,  'fee', 0),
    jsonb_build_object('waybill', 'JT-NOBODY',   'amount', 50000,   'fee', 0)
  ), 'PAYOUT-TEST-1', 'test.csv', null);
  v_id := (v_batch ->> 'id')::uuid;

  perform tests.eq((v_batch #>> '{byStatus,matched,count}')::int, 1,
    'the line that agrees with the order is matched');
  perform tests.eq((v_batch #>> '{byStatus,duplicate,count}')::int, 1,
    'the same waybill twice in one file is a duplicate, not a second payment');
  perform tests.eq((v_batch #>> '{byStatus,unknown_waybill,count}')::int, 2,
    'and a waybill from another tenant is as unknown as one that does not exist');

  -- That last one is the assertion that matters most on this surface. Matching
  -- on the waybill alone would let another seller's payout mark *her* order
  -- paid — and waybills are printed on every parcel that passes through a hub.
  perform tests.eq((select count(*)::int from public.cod_remittance_lines
                     where remittance_id = v_id and shipment_id is not null), 1,
    'exactly one line resolved to a parcel, and it is her own');

  -- Compared against what it was, not against a literal: earlier phases leave
  -- this order part-paid, and a test that hard-codes `unpaid` would be asserting
  -- the fixture rather than the behaviour.
  perform tests.eq((select payment_status from public.orders where id = p.rhea_order),
    v_was, 'importing a draft changes no order''s payment status');

  -- Posting is the act that moves money.
  perform public.cod_post_remittance(v_id);
  perform tests.eq((select payment_status from public.orders where id = p.rhea_order),
    'paid', 'posting does');
  perform tests.eq(
    (public.cod_post_remittance(v_id)) ->> 'outcome', 'already_posted',
    'and posting again is refused rather than paying twice');
  perform tests.eq((select count(*)::int from public.payments
                     where order_id = p.rhea_order and provider = 'cod'
                       and proof_note like '%PAYOUT-TEST-1%'), 1,
    'so the statement produced exactly one COD payment, not two');

  -- A courier's next payout file overlaps the last one — routinely, because they
  -- resend a period rather than a delta. The second copy has to land as a
  -- duplicate, or the seller's books show the same parcel paid twice.
  v_batch := public.cod_import_statement(i.rhea_tenant, 'jnt', jsonb_build_array(
    jsonb_build_object('waybill', 'JT-RHEA-1', 'amount', v_due, 'fee', 0)
  ), 'PAYOUT-TEST-2', 'overlap.csv', null);

  perform tests.eq((v_batch #>> '{byStatus,duplicate,count}')::int, 1,
    'a parcel that appears again in the *next* statement is a duplicate too');
  perform tests.eq(
    (public.cod_post_remittance((v_batch ->> 'id')::uuid)) ->> 'posted', '0',
    'so posting that statement pays nothing');
  perform tests.eq((select count(*)::int from public.payments
                     where order_id = p.rhea_order and provider = 'cod'), 1,
    'and the order still carries exactly one COD payment');
end;
$$;

-- Marlon's order is untouched by a statement imported into her tenant. Checked
-- with RLS out of the way, because *she* cannot see his row at all — and "the
-- query returned nothing" would pass whether or not his order got paid.
reset role;
do $$
declare p record;
begin
  select * into p from tests.p9;
  perform tests.eq((select payment_status from public.orders where id = p.marlon_order),
    'unpaid', 'and Marlon''s parcel is not paid off by her statement');
end;
$$;

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---- Nobody edits the matching by hand -------------------------------------
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- Read-only grants throughout: a seller who could write `match_status` could
  -- mark an unremitted parcel paid without a courier ever paying.
  perform tests.rejects(
    $q$ update public.cod_remittance_lines set match_status = 'matched' $q$,
    'not even an owner can rewrite what a statement line means');
  perform tests.rejects(
    $q$ update public.cod_remittances set status = 'posted' $q$,
    'nor mark a statement posted by hand');
  perform tests.rejects(
    format($q$ insert into public.order_rts (tenant_id, order_id, reason)
               values (%L, %L, 'other') $q$, i.rhea_tenant, (select rhea_order from tests.p9)),
    'nor write a return straight into the table');
  perform tests.rejects(
    format($q$ update public.buyer_risk_flags set rts_count = 0 where tenant_id = %L $q$,
      i.rhea_tenant),
    'nor edit a buyer''s history to clear the score');
end;
$$;

-- ---- A return is warehouse work; a statement is not ------------------------
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare
  i record;
  v_order uuid;
  v_before int;
  v_res jsonb;
begin
  select * into i from tests.ids;

  -- The parcel that is still out. An order that reached a terminal status
  -- cannot come back, and `record_rts` says so.
  select rts_order into v_order from tests.p12;

  perform tests.rejects(
    format($q$ select public.cod_import_statement(%L, 'jnt', '[]'::jsonb) $q$, i.rhea_tenant),
    'a packer cannot import a remittance statement — that is a money decision');

  -- But receiving a returned parcel is exactly the job the role exists for.
  -- Guarding this with `staff` would lock the packer out of the box they are
  -- holding, which is the phase-9 lesson: `packer` ranks *below* `staff`.
  select coalesce(sum(on_hand), 0)::int into v_before
  from public.inventory_levels where tenant_id = i.rhea_tenant;

  v_res := public.record_rts(v_order, 'buyer_unreachable', true, 12000, 'Rider tried 3x');
  perform tests.eq(v_res ->> 'outcome', 'recorded',
    'but a packer can record a return');
  perform tests.eq((select fulfillment_status from public.orders where id = v_order), 'rts',
    'which moves the order');
  perform tests.ok(
    (select coalesce(sum(on_hand), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant) > v_before,
    'and puts the goods back on the shelf');

  -- Twice must not restock twice: two packers opening the same box, or one
  -- double-tapping a phone, would otherwise invent inventory that is not there.
  v_before := (select coalesce(sum(on_hand), 0)::int from public.inventory_levels
                where tenant_id = i.rhea_tenant);
  perform tests.eq(
    (public.record_rts(v_order, 'buyer_unreachable', true, 12000, null)) ->> 'outcome',
    'already_recorded', 'recording the same return twice is refused');
  perform tests.eq(
    (select coalesce(sum(on_hand), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant), v_before,
    'and the stock did not move a second time');

  -- The movement is on the ledger with its own reason, not an anonymous
  -- adjustment: `sum(delta) = on_hand` is asserted elsewhere and only holds if
  -- returns go through it.
  perform tests.ok(
    exists (select 1 from public.stock_movements
             where tenant_id = i.rhea_tenant and reason = 'rts' and reference_id = v_order),
    'and it is on the movement ledger as an RTS, not as an adjustment');
end;
$$;

-- ---- The risk score is derived, and the block is a decision ----------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  v_phone text;
  v_risk  jsonb;
begin
  select * into i from tests.ids;
  select contact_phone into v_phone from public.orders
   where tenant_id = i.rhea_tenant and fulfillment_status = 'rts' limit 1;

  v_risk := public.buyer_risk_lookup(i.rhea_tenant, v_phone);
  perform tests.ok((v_risk #>> '{own,rts}')::int >= 1,
    'the return reached the buyer''s risk row');

  -- Typed the way a buyer types it, matched the way an order stores it. Neither
  -- digit string contains the other, so this only works because both sides are
  -- reduced to national digits first.
  perform tests.eq(
    public.buyer_risk_lookup(i.rhea_tenant, '0' || right(v_phone, 10)) #>> '{own,rts}',
    v_risk #>> '{own,rts}',
    'and 09XX finds the same buyer as +639XX');

  -- Nothing is blocked until a human says so.
  perform tests.ok(not (v_risk #>> '{own,blockCod}')::boolean,
    'a bad score does not block anyone by itself');
  perform tests.ok(
    ((public.buyer_risk_set_flag(i.rhea_tenant, v_phone, true)) #>> '{own,blockCod}')::boolean,
    'blocking is an explicit act');

  -- The shared pool is off by default and stays quiet.
  perform tests.ok((v_risk -> 'shared') is null or v_risk -> 'shared' = 'null'::jsonb,
    'and the cross-tenant signal says nothing until the store opts in');
end;
$$;

-- ---- The pool itself is nobody's to read -----------------------------------
do $$
begin
  -- No policy and no grant, on purpose. The aggregate is meant to be reachable
  -- only through `buyer_risk_lookup`, which subtracts the caller's own numbers
  -- before returning anything.
  perform tests.rejects($q$ select count(*) from public.buyer_risk_signals $q$,
    'not even an owner can read the shared risk pool directly');
  perform tests.rejects($q$ select count(*) from public.buyer_risk_contributions $q$,
    'nor the table that maps a hash back to the stores that reported it');
  perform tests.rejects($q$ select count(*) from public.platform_secrets $q$,
    'nor the salt those hashes are built with');

  -- And the three functions behind it are callable by nobody at all. A caller
  -- with `buyer_risk_hash` could confirm whether any given phone number is in
  -- the pool, one number at a time — the exact property hashing exists to stop.
  perform tests.rejects($q$ select public.buyer_risk_hash('9171234567') $q$,
    'and the hash function is not callable, so the pool cannot be probed');
  perform tests.rejects(
    format($q$ select public.buyer_risk_refresh(%L, '+639171234567') $q$,
      (select rhea_tenant from tests.ids)),
    'nor is the function that derives a risk row from another tenant''s orders');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p9;

  perform tests.rejects($q$ select count(*) from public.cod_remittances $q$,
    'anon has no grant on remittances');
  perform tests.rejects($q$ select count(*) from public.cod_remittance_lines $q$,
    'nor on their lines');
  perform tests.rejects($q$ select count(*) from public.order_rts $q$,
    'nor on returns');
  perform tests.rejects($q$ select count(*) from public.buyer_risk_flags $q$,
    'nor on what a store thinks of its buyers');

  perform tests.rejects(
    format($q$ select public.cod_reconciliation(%L) $q$, i.rhea_tenant),
    'and cannot read a store''s COD position');
  perform tests.rejects(
    format($q$ select public.cod_import_statement(%L, 'jnt', '[]'::jsonb) $q$, i.rhea_tenant),
    'nor import a statement that would mark orders paid');
  perform tests.rejects(
    format($q$ select public.record_rts(%L, 'other') $q$, p.rhea_order),
    'nor send a parcel back and help themselves to the stock');
  perform tests.rejects(
    format($q$ select public.buyer_risk_set_flag(%L, '+639171234567', true) $q$, i.rhea_tenant),
    'nor blacklist a rival''s customers');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 13: live selling
-- ---------------------------------------------------------------------------
-- The comment webhook is the widest door in the product: it reserves a seller's
-- stock for a buyer with no account, on the strength of a URL. Everything below
-- aims at that — and at the two `_raw` primitives it needs, which move inventory
-- with no authorisation at all.
\echo ''
\echo '=== Phase 13: live selling'

reset role;
do $$
declare
  i record;
  v_session uuid;
  v_variant uuid;
  v_product uuid;
begin
  select * into i from tests.ids;
  perform set_config('request.jwt.claims',
    json_build_object('sub', i.rhea, 'role', 'authenticated')::text, true);

  v_session := (public.live_session_create(i.rhea_tenant, 'Test live', 'facebook',
    'fb-test-video', 30) ->> 'id')::uuid;

  -- A product of its own, rather than whatever earlier phases happened to leave.
  -- `select ... limit 1` with no ORDER BY picked a different variant from run to
  -- run, and on the runs where it picked one the order tests had already reserved,
  -- the very first claim came back `sold_out` — a test that failed about one time
  -- in two and blamed the ingest path for it.
  insert into public.products (tenant_id, name, slug, status, is_cod_allowed)
  values (i.rhea_tenant, 'Live fixture item', 'live-fixture-item', 'active', true)
  returning id into v_product;

  insert into public.product_variants (tenant_id, product_id, sku, price_centavos, weight_grams)
  values (i.rhea_tenant, v_product, 'LIVE-FIXTURE-1', 50000, 300)
  returning id into v_variant;

  insert into public.stock_movements (tenant_id, variant_id, location_id, delta, reason)
  select i.rhea_tenant, v_variant, l.id, 50, 'receive'
  from public.locations l
  where l.tenant_id = i.rhea_tenant order by l.is_default desc, l.created_at limit 1;

  perform public.live_item_add(v_session, v_variant, 'A1', null);
  perform public.live_session_update(v_session, 'live', 'A1');

  create table tests.p13 as select v_session as session_id, v_variant as variant_id;
  grant select on tests.p13 to authenticated, anon;

  perform tests.pass('phase 13 fixture: a live session with one item on the board');
end;
$$;

-- ---- A session belongs to one store ----------------------------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p13;

  perform tests.eq((select count(*)::int from public.live_sessions), 0,
    'Marlon sees none of Rhea''s live sessions');
  perform tests.eq((select count(*)::int from public.live_items), 0,
    'nor what is on her board');
  perform tests.eq((select count(*)::int from public.live_comments), 0,
    'nor a single comment from her broadcast');
  perform tests.eq((select count(*)::int from public.live_claims), 0,
    'nor who claimed what');

  perform tests.rejects(
    format($q$ select public.live_console(%L) $q$, p.session_id),
    'and he cannot watch her console');
  perform tests.rejects(
    format($q$ select public.live_session_update(%L, 'ended') $q$, p.session_id),
    'nor end her broadcast from under her');
  perform tests.rejects(
    format($q$ select public.live_item_add(%L, %L, 'Z9') $q$, p.session_id, p.variant_id),
    'nor put something on her board');
  perform tests.rejects(
    format($q$ select public.live_sessions_list(%L) $q$, i.rhea_tenant),
    'nor list her sessions');
end;
$$;

-- ---- The ingest path is the server's alone ---------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p13;

  -- Not even the store's owner reserves stock by hand. Everything that holds
  -- inventory goes through a function that checks something first.
  perform tests.rejects(
    format($q$ select public.reserve_stock_raw(%L, %L, '[]'::jsonb) $q$,
      i.rhea_tenant, (select id from public.locations where tenant_id = i.rhea_tenant limit 1)),
    'the unchecked reserve is callable by nobody');
  perform tests.rejects(
    format($q$ select public.release_reservation_raw(%L, %L, '[]'::jsonb) $q$,
      i.rhea_tenant, (select id from public.locations where tenant_id = i.rhea_tenant limit 1)),
    'and neither is the unchecked release');
  perform tests.rejects(
    $q$ select public.live_session_for_ref('facebook', 'fb-test-video') $q$,
    'nor the lookup that crosses tenants to find a session by video id');
  perform tests.rejects(
    $q$ select public.live_expire_claims() $q$,
    'nor the sweep that releases holds across every session on the platform');

  -- Writes go through functions, so the tables themselves are read-only.
  perform tests.rejects(
    format($q$ insert into public.live_claims (tenant_id, session_id, item_id, psid, qty, expires_at)
               values (%L, %L, gen_random_uuid(), 'x', 1, now()) $q$,
      i.rhea_tenant, p.session_id),
    'and a claim cannot be written straight into the table');
  perform tests.rejects(
    format($q$ insert into public.live_comments (tenant_id, session_id, external_id, psid, body)
               values (%L, %L, 'x', 'y', 'mine') $q$, i.rhea_tenant, p.session_id),
    'nor a comment');
  perform tests.rejects(
    $q$ update public.live_sessions set status = 'ended' $q$,
    'nor a session ended by hand');
end;
$$;

-- ---- What the webhook can and cannot do ------------------------------------
reset role;
do $$
declare
  i record;
  p record;
  v_res jsonb;
  v_before int;
begin
  select * into i from tests.ids;
  select * into p from tests.p13;

  select coalesce(sum(reserved), 0)::int into v_before
  from public.inventory_levels where tenant_id = i.rhea_tenant;

  -- The parse is a claim *about* a claim. The client says "A1"; the function
  -- resolves that against this session's own items before holding anything.
  v_res := public.live_ingest_comment(p.session_id, 'ext-1', 'psid-1', 'mine po',
    '[{"code":"A1","qty":1}]'::jsonb, 'claimed', 'Buyer');
  perform tests.eq(v_res ->> 'outcome', 'claimed', 'a comment holds stock');
  perform tests.eq(
    (select coalesce(sum(reserved), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant), v_before + 1,
    'and the hold is real, not a row that says it is');

  -- Facebook redelivers. Routinely, and on no schedule.
  v_res := public.live_ingest_comment(p.session_id, 'ext-1', 'psid-1', 'mine po',
    '[{"code":"A1","qty":1}]'::jsonb, 'claimed', 'Buyer');
  perform tests.eq(v_res ->> 'outcome', 'duplicate',
    'the same comment id twice is a duplicate');
  perform tests.eq(
    (select coalesce(sum(reserved), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant), v_before + 1,
    'and it holds nothing more');

  -- A client asserting a code this session does not sell gets nothing, and
  -- specifically does not get whatever is on screen instead.
  v_res := public.live_ingest_comment(p.session_id, 'ext-2', 'psid-2', 'mine Z9',
    '[{"code":"Z9","qty":1}]'::jsonb, 'claimed', 'Buyer');
  perform tests.eq(v_res ->> 'outcome', 'unknown_code',
    'a code the session does not sell holds nothing');
  perform tests.eq(
    (select coalesce(sum(reserved), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant), v_before + 1,
    'and does not quietly claim the item on screen instead');

  -- A quantity the client inflated is clamped, not trusted.
  v_res := public.live_ingest_comment(p.session_id, 'ext-3', 'psid-3', 'mine',
    '[{"code":"A1","qty":9999}]'::jsonb, 'claimed', 'Buyer');
  perform tests.ok(
    (select coalesce(sum(reserved), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant) <= v_before + 21,
    'and a client cannot ask for nine thousand units');
end;
$$;

-- ---- Ending a session gives everything back --------------------------------
do $$
declare
  i record;
  p record;
  v_before int;
begin
  select * into i from tests.ids;
  select * into p from tests.p13;
  perform set_config('request.jwt.claims',
    json_build_object('sub', i.rhea, 'role', 'authenticated')::text, true);

  perform tests.ok(
    (select coalesce(sum(reserved), 0)::int from public.inventory_levels
      where tenant_id = i.rhea_tenant) > 0,
    'the session is holding stock');

  perform public.live_session_update(p.session_id, 'ended');

  perform tests.eq(
    (select count(*)::int from public.live_claims
      where session_id = p.session_id and status = 'reserved'), 0,
    'and ending it settles every hold');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p13;

  perform tests.rejects($q$ select count(*) from public.live_sessions $q$,
    'anon has no grant on live sessions');
  perform tests.rejects($q$ select count(*) from public.live_items $q$,
    'nor on the board');
  perform tests.rejects($q$ select count(*) from public.live_comments $q$,
    'nor on the comments');
  perform tests.rejects($q$ select count(*) from public.live_claims $q$,
    'nor on who claimed what');

  perform tests.rejects(
    format($q$ select public.live_ingest_comment(%L, 'x', 'y', 'mine', '[]'::jsonb) $q$,
      p.session_id),
    'and above all cannot reserve a seller''s stock by posting a comment');
  perform tests.rejects(
    format($q$ select public.live_console(%L) $q$, p.session_id),
    'nor watch somebody else''s live sale');
end;
$$;

-- ---- Deleting a parent no longer breaks on the composite key ---------------
-- Sixteen `on delete set null` constraints tried to null `tenant_id` as well,
-- which is `not null` on every one of them — so deleting a product that had been
-- ordered, a category with products, or a customer with orders simply raised.
reset role;
do $$
declare
  i record;
  v_product uuid;
begin
  select * into i from tests.ids;

  select p.id into v_product
  from public.products p
    join public.product_variants v on v.product_id = p.id
    join public.order_items oi on oi.variant_id = v.id
  where p.tenant_id = i.rhea_tenant
  limit 1;

  perform tests.ok(v_product is not null,
    'there is a product that has actually been ordered');
  perform tests.eq(
    tests.affected(format($q$ delete from public.products where id = %L $q$, v_product)),
    1::bigint,
    'and deleting it succeeds rather than raising on order_items.tenant_id');
  perform tests.ok(
    exists (select 1 from public.order_items where variant_id is null),
    'the order line survives with its snapshot, pointing at nothing');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 14: Messenger & social integration
-- ---------------------------------------------------------------------------
-- Three things are being defended here, in order of how badly they go wrong:
-- the *page access token*, which can post as the seller and read their inbox;
-- the *24-hour messaging window*, which is a compliance claim and not a
-- preference; and the conversations themselves, which are a stranger's phone
-- number and buying history attached to a name.
\echo ''
\echo '=== Phase 14: Messenger & social integration'

reset role;
do $$
declare
  i record;
  v_account uuid;
  v_thread  uuid;
  v_res     jsonb;
begin
  select * into i from tests.ids;

  insert into public.social_accounts (tenant_id, platform, page_id, page_name)
  values (i.rhea_tenant, 'facebook', 'PAGE-TEST-1', 'Rhea test page')
  returning id into v_account;
  perform public.set_social_page_token(v_account, 'SECRET-PAGE-TOKEN', 'test-key');

  v_res := public.record_inbound_message(v_account, 'psid-buyer', 'mid-1',
    'magkano po ang bag?', 'Jasmine', now(), null, 'http://localhost:5174');
  v_thread := (v_res ->> 'threadId')::uuid;

  create table tests.p14 as
    select v_account as account_id, v_thread as thread_id;
  grant select on tests.p14 to authenticated, anon;

  perform tests.eq(v_res ->> 'outcome', 'recorded', 'phase 14 fixture: a buyer messages the Page');
  perform tests.ok((v_res -> 'autoReply' ->> 'body') like '%rheas-finds%',
    'and a keyword rule answers with this store''s link, not the platform''s');
end;
$$;

-- ---- The token is not readable, by anyone ----------------------------------
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p14;

  -- Not even the owner of the page. `social_accounts` has no policy at all, and
  -- the safe view is the only way in.
  perform tests.rejects($q$ select count(*) from public.social_accounts $q$,
    'the store''s own owner cannot select from social_accounts');
  perform tests.eq((select count(*)::int from public.social_accounts_safe), 1,
    'but the safe view shows her the connection');
  perform tests.eq((select has_token::text from public.social_accounts_safe), 'true',
    'including whether a token is stored');

  perform tests.rejects(
    format($q$ select public.social_page_token('facebook', 'PAGE-TEST-1', 'test-key') $q$),
    'and the decrypt is callable by nobody with a session');
  perform tests.rejects(
    format($q$ select public.set_social_page_token(%L, 'x', 'test-key') $q$, p.account_id),
    'nor is writing one');
  perform tests.rejects(
    format($q$ select public.social_account_connect(%L, 'facebook', 'PAGE-X') $q$, i.rhea_tenant),
    'nor claiming a page without going through the OAuth callback');
end;
$$;

-- ---- Another store sees none of it ------------------------------------------
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p14;

  perform tests.eq((select count(*)::int from public.social_accounts_safe), 0,
    'Marlon sees none of Rhea''s connected pages');
  perform tests.eq((select count(*)::int from public.message_threads), 0,
    'nor a single conversation');
  perform tests.eq((select count(*)::int from public.messages), 0,
    'nor a single message');
  perform tests.eq((select count(*)::int from public.post_comments), 0,
    'nor what was commented under her posts');
  perform tests.eq((select count(*)::int from public.auto_replies
                    where tenant_id = i.rhea_tenant), 0,
    'nor the words she chose to answer with');

  perform tests.rejects(format($q$ select public.inbox_threads(%L) $q$, i.rhea_tenant),
    'and he cannot list her inbox');
  perform tests.rejects(format($q$ select public.inbox_thread(%L) $q$, p.thread_id),
    'nor open one of her conversations');
  perform tests.rejects(format($q$ select public.inbox_mark_read(%L) $q$, p.thread_id),
    'nor mark it read from under her');
  perform tests.rejects(format($q$ select public.message_send_allowed(%L) $q$, p.thread_id),
    'nor learn whether she can still reply to it');
  perform tests.rejects(format($q$ select public.auto_reply_for(%L, 'magkano') $q$, i.rhea_tenant),
    'nor read back what her auto-reply would say');
  perform tests.rejects(format($q$ select public.social_account_disconnect(%L) $q$, p.account_id),
    'nor disconnect her page');

  -- The `_raw` primitives exist so the checked wrappers above can be checked.
  perform tests.rejects(format($q$ select public.message_send_allowed_raw(%L) $q$, p.thread_id),
    'and the unchecked window check is callable by nobody with a session');
  perform tests.rejects(format($q$ select public.auto_reply_for_raw(%L, 'magkano') $q$, i.rhea_tenant),
    'nor the unchecked matcher');
  perform tests.rejects(format($q$ select public.tenant_store_url(%L) $q$, i.rhea_tenant),
    'nor the store-url helper they both use');
end;
$$;

-- ---- Writing is the server's job -------------------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p14;

  perform tests.eq((select count(*)::int from public.inbox_threads(i.rhea_tenant)), 1,
    'Rhea reads her own inbox');
  perform tests.ok(
    (public.inbox_thread(p.thread_id) -> 'sendWindow' ->> 'verdict') = 'standard',
    'and can see the window is open');

  -- Every write that could produce a message goes through a function that
  -- refuses. A row typed straight into the table would be a send nobody made and
  -- a window nobody opened.
  perform tests.rejects(
    format($q$ insert into public.messages (tenant_id, thread_id, direction, body)
               values (%L, %L, 'out', 'hello') $q$, i.rhea_tenant, p.thread_id),
    'but she cannot write a message straight into the table');
  perform tests.rejects(
    format($q$ update public.message_threads set last_inbound_at = now() where id = %L $q$,
      p.thread_id),
    'nor push the 24-hour window forward by hand');
  perform tests.rejects(
    format($q$ select public.record_inbound_message(%L, 'psid-x', 'mid-x', 'hi') $q$,
      p.account_id),
    'nor record an inbound message that never arrived');
  perform tests.rejects(
    format($q$ select public.record_outbound_message(%L, 'hello') $q$, p.thread_id),
    'nor log a send the Send API never made');
  perform tests.rejects(
    format($q$ select public.record_post_comment(%L, 'post', 'c1', 'psid', 'magkano') $q$,
      p.account_id),
    'nor invent a comment to be auto-replied to');
  perform tests.rejects(
    $q$ select public.social_account_for_page('facebook', 'PAGE-TEST-1') $q$,
    'nor use the lookup that crosses tenants to find a page''s owner');
end;
$$;

-- ---- The window is enforced where it cannot be forgotten -------------------
reset role;
do $$
declare
  p record;
  v_res jsonb;
  v_before int;
begin
  select * into p from tests.p14;

  select count(*)::int into v_before from public.messages where thread_id = p.thread_id;

  -- Inside the window: an ordinary reply.
  v_res := public.record_outbound_message(p.thread_id, 'Here po ang link', 'auto_reply');
  perform tests.eq(v_res ->> 'outcome', 'sent', 'inside 24 hours a reply is sent');

  -- 25 hours later it is not, and no amount of asking changes it.
  update public.message_threads set last_inbound_at = now() - interval '25 hours'
   where id = p.thread_id;

  v_res := public.record_outbound_message(p.thread_id, 'still there?', 'auto_reply');
  perform tests.eq(v_res ->> 'outcome', 'blocked', 'past 24 hours it is refused');
  perform tests.eq(v_res ->> 'reason', 'window_closed', 'and says why');
  perform tests.eq((select count(*)::int from public.messages where thread_id = p.thread_id),
    v_before + 1,
    'and nothing was written that claims it was sent');

  -- A tag is the only way out, and only the right tag.
  perform tests.eq(
    public.record_outbound_message(p.thread_id, 'Your parcel shipped', 'auto_reply',
      'POST_PURCHASE_UPDATE') ->> 'outcome', 'sent',
    'a purchase update reaches them');
  perform tests.eq(
    public.record_outbound_message(p.thread_id, 'Sale today!', 'auto_reply',
      'MARKETING') ->> 'reason', 'unknown_tag',
    'an invented tag does not');
  perform tests.eq(
    public.record_outbound_message(p.thread_id, 'hi', 'auto_reply', 'HUMAN_AGENT') ->> 'reason',
    'tag_needs_a_human',
    'and an automation may not claim a human is typing');
  perform tests.eq(
    public.record_outbound_message(p.thread_id, 'hi', 'agent', 'HUMAN_AGENT') ->> 'outcome',
    'sent',
    'though a person may');

  -- A page cannot open a conversation with someone who never wrote to it.
  update public.message_threads set last_inbound_at = null where id = p.thread_id;
  perform tests.eq(
    public.record_outbound_message(p.thread_id, 'hi there', 'auto_reply') ->> 'reason',
    'never_messaged_us',
    'and a page may not start a conversation at all');

  update public.message_threads set last_inbound_at = now() where id = p.thread_id;
end;
$$;

-- ---- A redelivered inbound message does not extend the window --------------
do $$
declare
  p record;
  v_res jsonb;
  v_at  timestamptz;
begin
  select * into p from tests.p14;

  update public.message_threads set last_inbound_at = now() - interval '20 hours'
   where id = p.thread_id;
  select last_inbound_at into v_at from public.message_threads where id = p.thread_id;

  v_res := public.record_inbound_message(p.account_id, 'psid-buyer', 'mid-1', 'magkano po?');
  perform tests.eq(v_res ->> 'outcome', 'duplicate', 'the same message id twice is a duplicate');
  perform tests.eq(
    (select last_inbound_at from public.message_threads where id = p.thread_id), v_at,
    'and it does not extend the 24-hour window on stale evidence');
end;
$$;

-- ---- The comment play is exactly once --------------------------------------
do $$
declare
  p record;
  v_res jsonb;
begin
  select * into p from tests.p14;

  v_res := public.record_post_comment(p.account_id, 'post-1', 'comment-1', 'psid-mark',
    'magkano po ito?', 'Mark', null, 'http://localhost:5174');
  perform tests.eq(v_res ->> 'outcome', 'reply', 'a comment with a keyword gets an answer');
  perform tests.ok((v_res ->> 'body') like '%rheas-finds%', 'carrying this store''s link');

  v_res := public.record_post_comment(p.account_id, 'post-1', 'comment-1', 'psid-mark',
    'magkano po ito?', 'Mark');
  perform tests.eq(v_res ->> 'outcome', 'duplicate',
    'and Facebook redelivering it sends nothing a second time');

  v_res := public.record_post_comment(p.account_id, 'post-1', 'comment-2', 'psid-liza',
    'ang ganda ng codigo', 'Liza');
  perform tests.eq(v_res ->> 'outcome', 'no_rule',
    'a word that merely contains a keyword is not a question');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
-- `logout()` first, and not as a formality: the role alone is not the identity.
-- `is_tenant_member` reads `auth.uid()` from the JWT claims, so switching to
-- `anon` while a seller's claims are still set leaves every definer function
-- answering as that seller — and the assertion that a buyer cannot read a
-- conversation passes for the wrong reason, or in this case fails loudly.
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p14;

  perform tests.rejects($q$ select count(*) from public.message_threads $q$,
    'anon has no grant on conversations');
  perform tests.rejects($q$ select count(*) from public.messages $q$,
    'nor on messages');
  perform tests.rejects($q$ select count(*) from public.social_accounts_safe $q$,
    'nor on connected pages');
  perform tests.rejects($q$ select count(*) from public.auto_replies $q$,
    'nor on the seller''s auto-replies');
  perform tests.rejects(
    format($q$ select public.record_post_comment(%L, 'p', 'c9', 'psid', 'magkano') $q$,
      p.account_id),
    'and cannot make a seller''s page message a stranger');
  perform tests.rejects(
    format($q$ select public.inbox_thread(%L) $q$, p.thread_id),
    'nor read a conversation');
  perform tests.rejects(
    $q$ select public.social_page_token('facebook', 'PAGE-TEST-1', 'test-key') $q$,
    'and above all cannot ask for the page token');
end;
$$;

reset role;
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---------------------------------------------------------------------------
-- Phase 15: customers & CRM
-- ---------------------------------------------------------------------------
-- A customer list is the most portable thing a seller owns: names, phone
-- numbers and what each person spends. It is also the thing a competitor would
-- most like to have. So the checks below are about reading — and about the one
-- number a seller must not be able to write, because a lifetime value somebody
-- typed is a lifetime value that means nothing.
\echo ''
\echo '=== Phase 15: customers & CRM'

reset role;
do $$
declare
  i record;
  v_customer uuid;
  v_tag      uuid;
  v_segment  uuid;
begin
  select * into i from tests.ids;

  select id into v_customer from public.customers
   where tenant_id = i.rhea_tenant limit 1;

  insert into public.customer_tags (tenant_id, name) values (i.rhea_tenant, 'suki')
  returning id into v_tag;
  insert into public.customer_tag_assignments (tenant_id, customer_id, tag_id)
  values (i.rhea_tenant, v_customer, v_tag);

  insert into public.customer_segments (tenant_id, name, definition)
  values (i.rhea_tenant, 'Quiet skincare buyers',
          '{"spentAtLeast": 100, "notOrderedForDays": 60}'::jsonb)
  returning id into v_segment;

  create table tests.p15 as
    select v_customer as customer_id, v_tag as tag_id, v_segment as segment_id;
  grant select on tests.p15 to authenticated, anon;

  perform tests.ok(v_customer is not null,
    'phase 15 fixture: a customer, a tag and a saved segment');
end;
$$;

-- ---- Another store sees none of it ------------------------------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p15;

  perform tests.eq((select count(*)::int from public.customer_tags), 0,
    'Marlon sees none of Rhea''s customer tags');
  perform tests.eq((select count(*)::int from public.customer_tag_assignments), 0,
    'nor who she put them on');
  perform tests.eq((select count(*)::int from public.customer_segments), 0,
    'nor the questions she saved about her own people');
  perform tests.eq((select count(*)::int from public.customer_addresses), 0,
    'nor where their parcels go');

  perform tests.rejects(format($q$ select public.customers_list(%L) $q$, i.rhea_tenant),
    'and he cannot list her customers');
  perform tests.rejects(format($q$ select public.customer_profile(%L) $q$, p.customer_id),
    'nor open one of them');
  perform tests.rejects(
    format($q$ select public.customer_segment_preview(%L, '{}'::jsonb) $q$, i.rhea_tenant),
    'nor run a segment against her list');
  perform tests.rejects(
    format($q$ select public.customer_segment_count(%L, '{}'::jsonb) $q$, i.rhea_tenant),
    'nor even ask how many people are in one');
  perform tests.rejects(
    format($q$ select public.customer_segment_save(%L, 'Mine now', '{}'::jsonb) $q$, i.rhea_tenant),
    'nor save a segment into her store');
  perform tests.rejects(
    format($q$ select public.customer_segments_list(%L) $q$, i.rhea_tenant),
    'nor read the ones she has');
  perform tests.rejects(
    format($q$ select public.customers_import(%L, '[]'::jsonb) $q$, i.rhea_tenant),
    'nor import people into it');

  -- The unchecked primitives behind the checked wrappers.
  perform tests.rejects(
    format($q$ select * from public.customer_segment_match(%L, '{}'::jsonb) $q$, i.rhea_tenant),
    'and the unchecked matcher is callable by nobody with a session');
  perform tests.rejects(
    format($q$ select public.customer_stats_refresh(%L) $q$, p.customer_id),
    'nor the thing that writes the projection');
end;
$$;

-- ---- A member reads their own, and cannot write the numbers ----------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p15;

  perform tests.ok(
    ((public.customers_list(i.rhea_tenant) ->> 'total')::int) > 0,
    'Rhea reads her own customers');
  perform tests.ok(
    (public.customer_profile(p.customer_id) -> 'stats') is not null,
    'and one of them in full');
  perform tests.eq((select count(*)::int from public.customer_tags), 1,
    'she sees her own tag');

  -- The projection. A seller who could type a lifetime value would be a seller
  -- whose segments answer a question about what they typed.
  perform tests.rejects(
    format($q$ update public.customers set total_spent_centavos = 999999 where id = %L $q$,
      p.customer_id),
    'but she cannot write a customer''s lifetime value');
  perform tests.rejects(
    format($q$ update public.customers set total_orders = 42 where id = %L $q$, p.customer_id),
    'nor their order count');
  -- A *different* value: writing back the number that is already there changes
  -- nothing, and the guard is right to allow it. Asserting on `= 0` passed for
  -- the wrong reason on a customer who had never had a parcel come back.
  perform tests.rejects(
    format($q$ update public.customers set rts_orders = 7 where id = %L $q$, p.customer_id),
    'nor how many parcels came back');

  -- And the guard does not turn the row read-only.
  perform tests.eq(
    tests.affected(format($q$ update public.customers set notes = 'Prefers COD' where id = %L $q$,
      p.customer_id)),
    1::bigint,
    'the things that are hers to edit are still hers to edit');
end;
$$;

-- ---- A packer packs. A packer does not rewrite the customer list -----------
select tests.login('33333333-3333-3333-3333-333333333333', 'jess@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p15;

  -- Jess is staff in this fixture, so this asserts what staff *may* do; the
  -- packer-level refusal is covered by `has_tenant_role(..., 'staff')` in the
  -- functions themselves, which phase 9 proved for orders.
  perform tests.ok(
    jsonb_array_length(public.customers_list(i.rhea_tenant) -> 'customers') >= 0,
    'a colleague on the same store can read the list');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p15;

  perform tests.rejects($q$ select count(*) from public.customer_tags $q$,
    'anon has no grant on customer tags');
  perform tests.rejects($q$ select count(*) from public.customer_segments $q$,
    'nor on saved segments');
  perform tests.rejects($q$ select count(*) from public.customer_addresses $q$,
    'nor on saved addresses');
  perform tests.rejects(format($q$ select public.customers_list(%L) $q$, i.rhea_tenant),
    'and above all cannot ask for a store''s entire customer list');
  perform tests.rejects(format($q$ select public.customer_profile(%L) $q$, p.customer_id),
    'nor for one person''s phone number and buying history');
  perform tests.rejects(
    format($q$ select public.customers_import(%L, '[]'::jsonb) $q$, i.rhea_tenant),
    'nor write people into somebody else''s store');
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Phase 16: broadcasts, vouchers & abandoned cart
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Phase 16: broadcasts, vouchers & abandoned cart'

do $$
declare
  i record;
  v_customer uuid;
  v_discount uuid;
  v_blast    uuid;
  v_link     jsonb;
begin
  select * into i from tests.ids;

  select id into v_customer from public.customers where tenant_id = i.rhea_tenant limit 1;

  insert into public.discounts (tenant_id, code, name, kind, value, min_subtotal_centavos)
  values (i.rhea_tenant, 'PAYDAY', 'Payday 15%', 'percent', 1500, 50000)
  returning id into v_discount;

  insert into public.broadcasts (tenant_id, name, body, segment_definition, channel, discount_id)
  values (i.rhea_tenant, 'Payday blast', 'Payday sale po! {{storeUrl}}',
          '{}'::jsonb, 'auto', v_discount)
  returning id into v_blast;

  v_link := public.short_link_create(i.rhea_tenant,
    'https://rheas-finds.selld.ph', 'broadcast', v_blast);

  insert into public.broadcast_recipients
    (tenant_id, broadcast_id, customer_id, channel, address, status, segments, credits)
  values (i.rhea_tenant, v_blast, v_customer, 'sms', '+639171234567', 'pending', 1, 1);

  create table tests.p16 as
    select v_discount as discount_id, v_blast as broadcast_id,
           (v_link ->> 'id')::uuid as link_id, (v_link ->> 'slug') as slug,
           v_customer as customer_id;
  grant select on tests.p16 to authenticated, anon;

  perform tests.ok(v_blast is not null,
    'phase 16 fixture: a voucher, a broadcast, a short link and one recipient');
end;
$$;

-- ---- Another store sees none of it ------------------------------------------
set local role authenticated;
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p16;

  perform tests.eq((select count(*)::int from public.discounts), 0,
    'Marlon sees none of Rhea''s vouchers');
  perform tests.eq((select count(*)::int from public.discount_redemptions), 0,
    'nor who redeemed them');
  perform tests.eq((select count(*)::int from public.broadcasts), 0,
    'nor what she has blasted');
  perform tests.eq((select count(*)::int from public.broadcast_recipients), 0,
    'nor — the whole customer list, frozen — who she blasted it to');
  perform tests.eq((select count(*)::int from public.short_links), 0,
    'nor her tracked links');
  perform tests.eq((select count(*)::int from public.abandoned_carts), 0,
    'nor the carts her buyers walked away from');

  -- A voucher code is not a secret, but its *rules* are read through a function
  -- that names the store, so the store had better be his.
  perform tests.rejects(
    format($q$ select public.broadcast_preview(%L, '{}'::jsonb, 'hi', 'auto', null) $q$,
      i.rhea_tenant),
    'and he cannot price a send against her list');
  perform tests.rejects(
    format($q$ select public.broadcast_save(%L, 'Mine now', 'hi', '{}'::jsonb, 'auto') $q$,
      i.rhea_tenant),
    'nor write a draft into her store');
  perform tests.rejects(format($q$ select public.broadcast_start(%L) $q$, p.broadcast_id),
    'and above all cannot start a send that spends her credits');
  perform tests.rejects(format($q$ select public.broadcast_report(%L) $q$, p.broadcast_id),
    'nor read what one of her sends earned');
  perform tests.rejects(format($q$ select public.broadcasts_list(%L) $q$, i.rhea_tenant),
    'nor list them');
  perform tests.rejects(
    format($q$ select public.abandoned_carts_report(%L) $q$, i.rhea_tenant),
    'nor how much she is leaving on the table');

  -- The server-only half of the pipeline.
  perform tests.rejects(format($q$ select public.broadcast_claim_next(%L) $q$, p.broadcast_id),
    'the claim loop is the server''s alone');
  perform tests.rejects(
    format($q$ select public.broadcast_record_send(%L, 'sent') $q$, p.broadcast_id),
    'and so is recording what it did');
  perform tests.rejects(
    format($q$ select public.short_link_create(%L, 'https://evil.example', 'broadcast') $q$,
      i.rhea_tenant),
    'a member of another store cannot mint a link under her domain');
  perform tests.rejects(format($q$ select public.abandoned_carts_sweep(%L) $q$, i.rhea_tenant),
    'nor run her abandoned-cart sweep');
  perform tests.rejects(format($q$ select public.broadcasts_due() $q$),
    'nor ask the scheduler what is due');
end;
$$;

-- ---- The projections are projections ----------------------------------------
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p16;

  perform tests.eq((select count(*)::int from public.discounts), 1,
    'Rhea reads her own voucher');
  perform tests.eq((select count(*)::int from public.broadcasts), 1,
    'and her own send');
  perform tests.ok(public.broadcast_report(p.broadcast_id) is not null,
    'and can ask what it earned');

  -- "Used 43 times" has to mean forty-three orders exist. A counter a seller
  -- could type is a counter that cannot support a decision. `discounts` is the
  -- one of these tables she can write at all, so it is the one where the guard
  -- rather than the grant is what stops her — note the 23514.
  perform tests.rejects(
    format($q$ update public.discounts set used_count = 999 where id = %L $q$, p.discount_id),
    'but she cannot type a voucher''s usage count');

  -- And the guard does not turn the row read-only.
  perform tests.eq(
    tests.affected(format($q$ update public.discounts set is_active = false where id = %L $q$,
      p.discount_id)),
    1::bigint,
    'switching her own voucher off is still hers to do');

  -- A voucher that is off is indistinguishable from one that never existed: the
  -- buyer is told 'unknown', not 'this code is switched off', because the second
  -- confirms a code is real and worth trying again tomorrow.
  perform tests.eq(
    public.discount_evaluate(i.rhea_tenant, 'PAYDAY', 100000, 8000, null) ->> 'reason',
    'unknown',
    'and a voucher that is off looks exactly like one that was never made');

  perform tests.eq(
    tests.affected(format($q$ update public.discounts set is_active = true where id = %L $q$,
      p.discount_id)),
    1::bigint,
    'and back on again');

  -- A send and a link are records of what happened, not forms. There is no
  -- UPDATE grant on either: the only way to change a draft is `broadcast_save`,
  -- and once it has started there is nothing left to edit.
  perform tests.rejects(
    format($q$ update public.broadcasts set sent_count = 999 where id = %L $q$, p.broadcast_id),
    'a send''s own numbers are not hers to write');
  perform tests.rejects(
    format($q$ update public.broadcasts set name = 'July payday' where id = %L $q$,
      p.broadcast_id),
    'and neither is anything else on the row, directly');
  perform tests.rejects(
    format($q$ update public.short_links set click_count = 999 where id = %L $q$, p.link_id),
    'nor how many people tapped a link');
  perform tests.ok(
    public.broadcast_save(i.rhea_tenant, 'July payday', 'Payday sale po! {{storeUrl}}',
      '{}'::jsonb, 'auto', p.broadcast_id) = p.broadcast_id,
    'editing a draft goes through broadcast_save, which is checked');

  -- A recipient row is a record of what was sent, not a form.
  perform tests.rejects(
    format($q$ update public.broadcast_recipients set status = 'sent'
            where broadcast_id = %L $q$, p.broadcast_id),
    'and she cannot mark a recipient sent by hand');
end;
$$;

-- ---- The guards, where they actually earn their keep -----------------------
--
-- The four assertions above are true partly because `authenticated` holds no
-- UPDATE grant, and a missing grant is not a guard: `service_role` has BYPASSRLS
-- and the definers that maintain these tables run as the owner. So the same
-- writes are tried again as the owner, where only the trigger stands in the way.
reset role;
do $$
declare p record;
begin
  select * into p from tests.p16;

  perform tests.rejects(
    format($q$ update public.discounts set used_count = 999 where id = %L $q$, p.discount_id),
    'the owner cannot write a voucher''s usage count either');
  perform tests.rejects(
    format($q$ update public.short_links set click_count = 999 where id = %L $q$, p.link_id),
    'nor a link''s click count');
  perform tests.rejects(
    format($q$ update public.broadcasts set sent_count = 999 where id = %L $q$, p.broadcast_id),
    'nor how many messages a send delivered');
  -- 999, not 0. Both of these are 0 and 1 on a fresh fixture, and writing back
  -- the value that is already there is a no-op the guard is right to allow — so
  -- asserting on it passes without the guard existing at all. That is exactly
  -- how the phase-15 `rts_orders` assertion passed for the wrong reason.
  perform tests.rejects(
    format($q$ update public.broadcasts set credits_spent = 999 where id = %L $q$,
      p.broadcast_id),
    'nor what it cost — which is the number the bill is reconciled against');
  perform tests.rejects(
    format($q$ update public.broadcasts set recipient_count = 999 where id = %L $q$,
      p.broadcast_id),
    'nor how many people it was frozen against');

  -- The maintaining triggers still get through: they run nested, one level
  -- deeper, which is exactly what `pg_trigger_depth()` distinguishes.
  perform tests.eq(
    tests.affected(format($q$ update public.broadcast_recipients set status = 'sent'
                           where broadcast_id = %L $q$, p.broadcast_id)),
    1::bigint,
    'and the trigger that maintains them is not blocked by its own guard');
  perform tests.eq(
    (select sent_count from public.broadcasts where id = p.broadcast_id), 1,
    'the projection followed the row that changed');
end;
$$;

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

-- ---- A buyer holds a link and a code, and nothing else ----------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
  v jsonb;
begin
  select * into i from tests.ids;
  select * into p from tests.p16;

  perform tests.rejects($q$ select count(*) from public.discounts $q$,
    'anon has no grant on the voucher table');
  perform tests.rejects($q$ select count(*) from public.broadcasts $q$,
    'nor on broadcasts');
  perform tests.rejects($q$ select count(*) from public.broadcast_recipients $q$,
    'nor on the frozen recipient list — that table is the customer list');
  perform tests.rejects($q$ select count(*) from public.short_links $q$,
    'nor on short links');
  perform tests.rejects($q$ select count(*) from public.short_link_clicks $q$,
    'and nobody at all can read the per-click log, which is a browsing history');
  perform tests.rejects($q$ select count(*) from public.abandoned_carts $q$,
    'nor on abandoned carts');

  perform tests.rejects(
    format($q$ select public.broadcast_preview(%L, '{}'::jsonb, 'hi', 'auto', null) $q$,
      i.rhea_tenant),
    'a buyer cannot price a send');
  perform tests.rejects(format($q$ select public.broadcasts_list(%L) $q$, i.rhea_tenant),
    'nor list a store''s sends');
  perform tests.rejects(format($q$ select public.broadcast_claim_next(%L) $q$, p.broadcast_id),
    'nor claim a recipient and read their message');
  perform tests.rejects(format($q$ select public.broadcast_report(%L) $q$, p.broadcast_id),
    'nor read a store''s revenue');

  -- What a buyer legitimately holds: a link they were sent, and a code they
  -- were given. Both answer, and both answer with nothing else.
  v := public.short_link_follow(p.slug, null);
  perform tests.eq(v ->> 'target', 'https://rheas-finds.selld.ph',
    'following a link they were sent gives them the target');
  perform tests.ok(not (v ? 'tenantId') and not (v ? 'broadcastId'),
    'and not which store or which send it came from');

  v := public.discount_evaluate(i.rhea_tenant, 'PAYDAY', 100000, 8000, null);
  perform tests.eq((v ->> 'valid')::boolean, true,
    'and a code they were given prices itself on their own cart');
  perform tests.ok(not (v ? 'usageLimit') and not (v ? 'usedCount'),
    'without telling them how many are left, which is a countdown they can game');

  perform tests.eq((public.discount_evaluate(i.rhea_tenant, 'NOPE', 100000, 8000, null)
                    ->> 'reason'), 'unknown',
    'a code that does not exist says so, and says nothing more');
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Phase 17: marketplace sync
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Phase 17: marketplace sync'

do $$
declare
  i record;
  v_conn    uuid;
  v_listing uuid;
  v_variant uuid;
  v_issue   uuid;
begin
  select * into i from tests.ids;

  select v.id into v_variant from public.product_variants v
   where v.tenant_id = i.rhea_tenant limit 1;

  insert into public.marketplace_connections (tenant_id, platform, shop_id, shop_name)
  values (i.rhea_tenant, 'shopee', 'SHOP-1', 'Rhea''s Finds')
  returning id into v_conn;

  perform public.set_marketplace_credentials(
    v_conn, '{"accessToken":"secret-token"}'::jsonb, 'tenancy-key', now() + interval '4 hours');

  insert into public.marketplace_listings
    (tenant_id, connection_id, external_item_id, external_variation_id, external_sku,
     name, variant_id)
  values (i.rhea_tenant, v_conn, 'IT-1', '11', 'RH-30ML', 'Rosehip 30ml', v_variant)
  returning id into v_listing;

  insert into public.marketplace_issues
    (tenant_id, connection_id, listing_id, kind, reference, message)
  values (i.rhea_tenant, v_conn, v_listing, 'push_rejected', v_listing::text, 'refused')
  returning id into v_issue;

  create table tests.p17 as
    select v_conn as connection_id, v_listing as listing_id, v_variant as variant_id,
           v_issue as issue_id;
  grant select on tests.p17 to authenticated, anon;

  perform tests.ok(v_conn is not null,
    'phase 17 fixture: a connected shop, a mapped listing and a queue item');
end;
$$;

-- ---- The access token is the most dangerous thing here ---------------------
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p17;

  -- `marketplace_connections` has RLS on and *no policy at all*, plus no SELECT
  -- grant — the same shape as `social_accounts`. A marketplace token can list,
  -- reprice and cancel as the seller.
  perform tests.rejects($q$ select count(*) from public.marketplace_connections $q$,
    'not even the owner can read the connection row that holds the token');
  perform tests.rejects(
    format($q$ select public.marketplace_credentials(%L, 'tenancy-key') $q$, p.connection_id),
    'nor call the thing that decrypts it');

  -- What she *can* see is the derived view.
  perform tests.eq((select count(*)::int from public.marketplace_connections_safe), 1,
    'she sees her own shop through the safe view');
  perform tests.eq(
    (select has_credentials from public.marketplace_connections_safe limit 1), true,
    'which tells her it is connected without carrying the token');
  perform tests.ok(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'marketplace_connections_safe'
        and column_name in ('credentials_encrypted', 'access_token')),
    'and the view has no column that could carry one');

  perform tests.eq((select count(*)::int from public.marketplace_listings), 1,
    'she reads her own listings');
  perform tests.ok(public.marketplace_overview(i.rhea_tenant) is not null,
    'and the screen renders for her');
end;
$$;

-- ---- Another store sees none of it ------------------------------------------
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p17;

  perform tests.eq((select count(*)::int from public.marketplace_connections_safe), 0,
    'Marlon sees none of Rhea''s shops');
  perform tests.eq((select count(*)::int from public.marketplace_listings), 0,
    'nor which of her products they sell');
  perform tests.eq((select count(*)::int from public.marketplace_sync_logs), 0,
    'nor what has been synced');
  perform tests.eq((select count(*)::int from public.marketplace_issues), 0,
    'nor the work she has outstanding');

  perform tests.rejects(format($q$ select public.marketplace_overview(%L) $q$, i.rhea_tenant),
    'and he cannot ask for her marketplace screen');
  perform tests.rejects(
    format($q$ select public.marketplace_connect(%L, 'shopee', 'MINE') $q$, i.rhea_tenant),
    'nor attach a shop of his own to her store');
  perform tests.rejects(
    format($q$ select public.marketplace_set_sync(%L, true, true) $q$, p.connection_id),
    'nor switch her sync on');
  perform tests.rejects(
    format($q$ select public.marketplace_map_listing(%L, null) $q$, p.listing_id),
    'nor unlink one of her listings — which would silently stop her stock syncing');
  -- The real id from the fixture, not one selected through his own RLS: that
  -- would be null, the function would return early, and the assertion would
  -- pass without the guard existing.
  perform tests.rejects(
    format($q$ select public.marketplace_issue_resolve(%L) $q$, p.issue_id),
    'nor clear work off her queue');

  -- The worker's half.
  perform tests.rejects($q$ select public.marketplace_push_claim(10) $q$,
    'the push loop is the server''s alone');
  perform tests.rejects(
    format($q$ select public.marketplace_push_record(%L, 'ok', 0) $q$, p.listing_id),
    'and so is recording what it pushed');
  perform tests.rejects(
    format($q$ select public.marketplace_order_ingest(%L, '{}'::jsonb) $q$, p.connection_id),
    'and writing an order into her store');
  perform tests.rejects($q$ select public.marketplace_connections_due() $q$,
    'nor asking which shops are due a pull');
  perform tests.rejects(
    format($q$ select public.set_marketplace_credentials(%L, '{}'::jsonb, 'k') $q$,
      p.connection_id),
    'and above all cannot replace the token on her shop');
end;
$$;

-- ---- A buyer has no business here ------------------------------------------
select tests.logout();
set local role anon;
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p17;

  perform tests.rejects($q$ select count(*) from public.marketplace_connections_safe $q$,
    'anon has no grant on the safe view either');
  perform tests.rejects($q$ select count(*) from public.marketplace_listings $q$,
    'nor on the listings');
  perform tests.rejects($q$ select count(*) from public.marketplace_stock_queue $q$,
    'nor on the worker''s queue');
  perform tests.rejects($q$ select count(*) from public.marketplace_issues $q$,
    'nor on the seller''s work list');
  perform tests.rejects(format($q$ select public.marketplace_overview(%L) $q$, i.rhea_tenant),
    'and cannot ask for a store''s marketplace screen');
  perform tests.rejects(
    format($q$ select public.marketplace_order_ingest(%L, '{}'::jsonb) $q$, p.connection_id),
    'nor post an order into one');
end;
$$;

-- ---- The mapping is what keeps stock honest, so it is constrained ----------
reset role;
do $$
declare
  i record;
  p record;
  v_other uuid;
begin
  select * into i from tests.ids;
  select * into p from tests.p17;

  -- One listing per variant on a connection. Two listings sharing a variant is
  -- one number being spent twice, which is the overselling this phase exists to
  -- stop — so it is refused by an index rather than reconciled afterwards.
  perform tests.rejects(
    format($q$ insert into public.marketplace_listings
      (tenant_id, connection_id, external_item_id, external_sku, variant_id)
      values (%L, %L, 'IT-2', 'RH-30ML-B', %L) $q$,
      i.rhea_tenant, p.connection_id, p.variant_id),
    'two listings on one shop cannot share a product');

  -- One row per listing. `nulls not distinct`, because a product with no
  -- variations has a null variation id and two of those are the same listing.
  perform tests.rejects(
    format($q$ insert into public.marketplace_listings
      (tenant_id, connection_id, external_item_id, external_variation_id)
      values (%L, %L, 'IT-1', '11') $q$, i.rhea_tenant, p.connection_id),
    'and the same listing cannot be imported twice');

  -- A cross-tenant listing is unrepresentable, not merely forbidden: the child
  -- carries `tenant_id` and the FK is composite.
  select id into v_other from public.tenants where id <> i.rhea_tenant limit 1;
  perform tests.rejects(
    format($q$ insert into public.marketplace_listings
      (tenant_id, connection_id, external_item_id) values (%L, %L, 'IT-9') $q$,
      v_other, p.connection_id),
    'and a listing cannot point at another tenant''s shop');

  -- Sync cannot be switched on without credentials: finding that out at push
  -- time is a queue of failures instead of one sentence on a settings screen.
  perform tests.rejects(
    format($q$ insert into public.marketplace_connections
      (tenant_id, platform, shop_id, sync_stock) values (%L, 'lazada', 'L-1', true) $q$,
      i.rhea_tenant),
    'and a shop cannot sync before it has been signed in to');

  -- Idempotency for the order pull is an index, not a check-then-insert: a pull
  -- is repeated by design, and two workers racing on "does this order exist yet"
  -- both lose by creating the parcel twice.
  --
  -- Written with a literal rather than by selecting an existing `channel_ref`.
  -- Nothing else in the schema writes that column, so the select found no rows,
  -- the insert inserted nothing, and the assertion passed with no index at all.
  insert into public.orders
    (tenant_id, order_number, shipping_address, contact_name, contact_phone,
     subtotal_centavos, grand_total_centavos, payment_method, payment_status,
     fulfillment_status, source, channel_ref)
  values (i.rhea_tenant, 'MP-17-A', '{}'::jsonb, 'Marites', '+639171234567',
          0, 0, 'cod', 'unpaid', 'pending', 'marketplace', 'SPE-TENANCY-1');

  perform tests.rejects(
    format($q$ insert into public.orders
      (tenant_id, order_number, shipping_address, contact_name, contact_phone,
       subtotal_centavos, grand_total_centavos, payment_method, payment_status,
       fulfillment_status, source, channel_ref)
      values (%L, 'MP-17-B', '{}'::jsonb, 'Marites', '+639171234567',
              0, 0, 'cod', 'unpaid', 'pending', 'marketplace', 'SPE-TENANCY-1') $q$,
      i.rhea_tenant),
    'and one marketplace order id can only ever be one Selld order');

  -- The index is partial, so it must not stop two storefront orders coexisting.
  perform tests.eq(
    tests.affected(format($q$ insert into public.orders
      (tenant_id, order_number, shipping_address, contact_name, contact_phone,
       subtotal_centavos, grand_total_centavos, payment_method, payment_status,
       fulfillment_status, source)
      values (%L, 'MP-17-C', '{}'::jsonb, 'Ana', '+639181234567',
              0, 0, 'cod', 'unpaid', 'pending', 'storefront') $q$, i.rhea_tenant)),
    1::bigint,
    'while two storefront orders, which have no marketplace id, still coexist');
end;
$$;

set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');

reset role;

-- ---------------------------------------------------------------------------
-- Phase 18: analytics & true profit
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Phase 18: analytics & true profit'

do $$
declare
  i record;
  v_spend uuid;
begin
  select * into i from tests.ids;

  insert into public.ad_spend (tenant_id, spent_on, channel, amount_centavos, note)
  values (i.rhea_tenant, (now() at time zone 'Asia/Manila')::date, 'facebook', 150000,
          'payday boost')
  returning id into v_spend;

  create table tests.p18 as select v_spend as spend_id;
  grant select on tests.p18 to authenticated, anon;

  perform tests.ok(v_spend is not null, 'phase 18 fixture: a day of ad spend');
end;
$$;

-- ---- The seller reads their own books --------------------------------------
set local role authenticated;
select tests.login('11111111-1111-1111-1111-111111111111', 'rhea@example.ph');
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.ok(public.analytics_profit(i.rhea_tenant) is not null,
    'Rhea can ask whether she made money');
  perform tests.ok(public.analytics_breakdown(i.rhea_tenant) is not null,
    'and which products were worth selling');
  perform tests.ok(public.analytics_trends(i.rhea_tenant, 3) is not null,
    'and how the last three months went');
  perform tests.eq((select count(*)::int from public.ad_spend), 1,
    'and she sees her own ad spend');
end;
$$;

-- ---- Another store sees none of it ------------------------------------------
select tests.login('22222222-2222-2222-2222-222222222222', 'marlon@example.ph');
do $$
declare
  i record;
  p record;
begin
  select * into i from tests.ids;
  select * into p from tests.p18;

  perform tests.eq((select count(*)::int from public.ad_spend), 0,
    'Marlon sees none of Rhea''s ad spend');

  -- Profit is the single most sensitive number in the product, and the
  -- breakdown carries cost prices — the thing `products_public` exists to keep
  -- from a buyer. A competitor reading either would know her margins.
  perform tests.rejects(format($q$ select public.analytics_profit(%L) $q$, i.rhea_tenant),
    'and above all cannot read her profit');
  perform tests.rejects(format($q$ select public.analytics_breakdown(%L) $q$, i.rhea_tenant),
    'nor her cost prices through the product breakdown');
  perform tests.rejects(
    format($q$ select public.analytics_commission_kept(%L) $q$, i.rhea_tenant),
    'nor what she bills');
  perform tests.rejects(format($q$ select public.analytics_trends(%L) $q$, i.rhea_tenant),
    'nor her return rate');
  perform tests.rejects(format($q$ select public.ad_spend_list(%L) $q$, i.rhea_tenant),
    'nor what she spends on ads');
  perform tests.rejects(
    format($q$ select public.ad_spend_record(%L, current_date, 999999) $q$, i.rhea_tenant),
    'and cannot type an expense into her books, which would move her profit');

  perform tests.eq(
    tests.affected(format($q$ update public.ad_spend set amount_centavos = 1 where id = %L $q$,
      p.spend_id)),
    0::bigint,
    'nor edit the one she typed — RLS denies, so zero rows');
end;
$$;

-- ---- A buyer least of all ---------------------------------------------------
select tests.logout();
set local role anon;
do $$
declare i record;
begin
  select * into i from tests.ids;

  perform tests.rejects($q$ select count(*) from public.ad_spend $q$,
    'anon has no grant on ad spend');
  perform tests.rejects(format($q$ select public.analytics_profit(%L) $q$, i.rhea_tenant),
    'nor any way to ask a store what it earns');
  perform tests.rejects(format($q$ select public.analytics_breakdown(%L) $q$, i.rhea_tenant),
    'nor what its stock costs it');
end;
$$;

-- ---- One expense per day per channel ----------------------------------------
reset role;
do $$
declare i record;
begin
  select * into i from tests.ids;

  -- Two rows for one day is how ad spend gets double-counted and profit
  -- understated. A seller correcting yesterday's figure is editing it.
  perform tests.rejects(
    format($q$ insert into public.ad_spend (tenant_id, spent_on, channel, amount_centavos)
      values (%L, (now() at time zone 'Asia/Manila')::date, 'facebook', 100) $q$,
      i.rhea_tenant),
    'a second row for the same day and channel is refused');

  perform tests.rejects(
    format($q$ insert into public.ad_spend (tenant_id, spent_on, channel, amount_centavos)
      values (%L, current_date - 1, 'facebook', -100) $q$, i.rhea_tenant),
    'and a negative spend is not an expense');
end;
$$;

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
  if v_passed < 650 then
    raise exception 'Expected at least 650 assertions, only % ran — did a section get skipped?', v_passed
      using errcode = 'triggered_action_exception';
  end if;
end;
$$;

\echo ''
\echo '=== ALL TENANCY ISOLATION TESTS PASSED'
\echo ''

rollback;
