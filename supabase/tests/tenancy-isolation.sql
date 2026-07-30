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
  if v_passed < 100 then
    raise exception 'Expected at least 100 assertions, only % ran — did a section get skipped?', v_passed
      using errcode = 'triggered_action_exception';
  end if;
end;
$$;

\echo ''
\echo '=== ALL TENANCY ISOLATION TESTS PASSED'
\echo ''

rollback;
