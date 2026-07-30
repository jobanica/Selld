-- Phase 1 — auth & multi-tenant core.
--
-- Four tables (tenants, profiles, tenant_members, invitations) plus the RLS
-- helper functions every later phase will build policies on.
--
-- SECURITY MODEL — read this before adding a tenant-scoped table.
--
-- The boundary is `public.is_tenant_member(tenant_id)`, not a "current tenant"
-- variable. Every tenant-scoped policy asks "is the caller a member of the tenant
-- that owns this row?" — a question the client cannot influence. `current_tenant_id()`
-- exists for defaults and convenience only; it validates membership before
-- returning anything, so it can never be pointed at a tenant the caller is not in.
--
-- The helpers are SECURITY DEFINER on purpose. A policy on `tenant_members` that
-- queried `tenant_members` directly would recurse infinitely; a definer function
-- runs as owner, skips RLS on the lookup, and terminates. Each one pins
-- `search_path = ''` so a caller cannot shadow `public` or `auth` with their own
-- schema and change what the function resolves.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create type public.tenant_role as enum ('owner', 'admin', 'staff', 'packer', 'rider');

comment on type public.tenant_role is
  'Team roles, ordered by capability via tenant_role_rank(). owner is the only role that can delete a tenant.';

-- Ranked so permission checks read as "at least staff" instead of enumerating
-- role lists at every call site.
create or replace function public.tenant_role_rank(role public.tenant_role)
returns int
language sql
immutable
parallel safe
as $$
  select case role
    when 'rider'  then 10
    when 'packer' then 20
    when 'staff'  then 30
    when 'admin'  then 40
    when 'owner'  then 50
  end;
$$;

-- ---------------------------------------------------------------------------
-- Slug rules — the database is the authority
-- ---------------------------------------------------------------------------
-- Every slug becomes a hostname ({slug}.selld.ph), so it must be a valid DNS
-- label. `src/lib/tenant/resolve-tenant.ts` mirrors these rules for client-side
-- validation, but this is the copy that decides.
create or replace function public.is_valid_tenant_slug(slug text)
returns boolean
language sql
immutable
parallel safe
as $$
  select slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$' and length(slug) between 3 and 63;
$$;

create or replace function public.is_reserved_tenant_slug(slug text)
returns boolean
language sql
immutable
parallel safe
as $$
  select lower(slug) = any (array[
    'app', 'www', 'api', 'admin', 'dashboard', 'staging', 'preview', 'cdn',
    'assets', 'mail', 'status', 'docs', 'help', 'blog', 'support', 'billing',
    'account', 'auth', 'login', 'signup', 'static', 'public', 'internal',
    'selld', 'test', 'demo'
  ]);
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
create table public.tenants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 120),
  slug           text not null unique
                   check (public.is_valid_tenant_slug(slug)
                          and not public.is_reserved_tenant_slug(slug)),
  custom_domain  text unique,
  logo_path      text,
  -- Storefront brand colours (phase 2 writes these; phase 5 renders them).
  brand_color    text check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  status         text not null default 'active'
                   check (status in ('active', 'suspended', 'cancelled')),
  -- PH-only for v1, but stored rather than assumed so multi-country is a data
  -- change instead of a schema change.
  timezone       text not null default 'Asia/Manila',
  locale         text not null default 'en' check (locale in ('en', 'tl')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index tenants_status_idx on public.tenants (status);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

comment on table public.tenants is 'One row per seller store. Root of every tenant-scoped table.';

-- ---------------------------------------------------------------------------
-- profiles — extends auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (full_name is null or length(btrim(full_name)) between 1 and 120),
  -- E.164, normalised by src/lib/phone before it ever reaches here. Constrained
  -- so an un-normalised number cannot slip in from a script or the SQL editor.
  phone       text check (phone is null or phone ~ '^\+63[0-9]{9,10}$'),
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index profiles_phone_idx on public.profiles (phone) where phone is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

comment on table public.profiles is
  'Per-user data. Not tenant-scoped — one human can belong to several tenants.';

-- A profile row must exist for every auth user, so it is created by trigger
-- rather than by the client, which might never call it.
--
-- Note: this reads phone from raw_user_meta_data, NOT auth.users.phone. Older
-- auth schema revisions (including the Postgres image CI runs) have no `phone`
-- column, and referencing it would make this migration fail there.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  v_phone := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '');

  -- Accept 639… as well as +639…; anything else is dropped rather than allowed
  -- to violate the constraint and abort signup.
  if v_phone is not null and left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;
  if v_phone is not null and v_phone !~ '^\+63[0-9]{9,10}$' then
    v_phone := null;
  end if;

  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    v_phone
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- tenant_members
-- ---------------------------------------------------------------------------
create table public.tenant_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  -- References profiles, not auth.users directly. profiles.id already cascades
  -- from auth.users, so deletion behaviour is identical — but routing through
  -- profiles keeps a single unambiguous foreign key, which is what lets
  -- PostgREST embed `profiles(...)` when loading a roster. Two FKs on one column
  -- would make that embed ambiguous.
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.tenant_role not null default 'staff',
  invited_at  timestamptz,
  -- NULL until the invite is accepted. Un-accepted rows grant nothing.
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index tenant_members_user_idx on public.tenant_members (user_id);
create index tenant_members_tenant_idx on public.tenant_members (tenant_id);

create trigger tenant_members_set_updated_at
  before update on public.tenant_members
  for each row execute function public.set_updated_at();

comment on table public.tenant_members is
  'Membership and role. accepted_at IS NULL means the invitation is still pending and confers no access.';

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  email       text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  role        public.tenant_role not null default 'staff',
  -- Opaque bearer token. Anyone holding it can accept, so it is never exposed
  -- through a SELECT policy — acceptance goes through accept_invitation().
  token       text not null unique default encode(extensions.gen_random_bytes(32), 'hex'),
  invited_by  uuid references public.profiles (id) on delete set null,
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One live invitation per email per tenant; re-inviting replaces the old one.
create unique index invitations_pending_unique
  on public.invitations (tenant_id, email)
  where accepted_at is null;

create index invitations_email_idx on public.invitations (email);

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

comment on table public.invitations is
  'Pending team invitations. Accept via accept_invitation(token) — the token is never readable through RLS.';

-- ---------------------------------------------------------------------------
-- RLS helper functions
-- ---------------------------------------------------------------------------

-- THE security boundary. Every tenant-scoped policy in the app funnels through
-- this. Only accepted memberships count.
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
  );
$$;

comment on function public.is_tenant_member(uuid) is
  'True when the current user has an accepted membership in the tenant. SECURITY DEFINER to avoid RLS recursion on tenant_members.';

create or replace function public.tenant_role_of(p_tenant_id uuid)
returns public.tenant_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.tenant_members m
  where m.tenant_id = p_tenant_id
    and m.user_id = auth.uid()
    and m.accepted_at is not null;
$$;

-- "At least this role" check, so policies do not enumerate role lists.
create or replace function public.has_tenant_role(
  p_tenant_id uuid,
  p_min_role public.tenant_role
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.tenant_role_rank(public.tenant_role_of(p_tenant_id))
      >= public.tenant_role_rank(p_min_role),
    false
  );
$$;

comment on function public.has_tenant_role(uuid, public.tenant_role) is
  'True when the current user is a member of the tenant with at least the given role.';

-- Convenience only, never the sole boundary.
--
-- Prefers the tenant named by the `x-selld-tenant` request header, but ONLY if
-- the caller actually belongs to it; otherwise falls back to their oldest
-- membership. A spoofed header therefore cannot reach another tenant's data — the
-- worst it can do is get the caller their own default.
create or replace function public.current_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw       text;
  v_requested uuid;
begin
  begin
    v_raw := nullif(
      current_setting('request.headers', true)::json ->> 'x-selld-tenant',
      ''
    );
  exception when others then
    -- No/!JSON headers (direct psql, background job): fall through to default.
    v_raw := null;
  end;

  -- Validate the shape before casting; a malformed header must not raise.
  if v_raw is not null
     and v_raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    v_requested := v_raw::uuid;
    if public.is_tenant_member(v_requested) then
      return v_requested;
    end if;
  end if;

  return (
    select m.tenant_id
    from public.tenant_members m
    where m.user_id = auth.uid()
      and m.accepted_at is not null
    order by m.created_at, m.id
    limit 1
  );
end;
$$;

comment on function public.current_tenant_id() is
  'The caller''s active tenant, from the x-selld-tenant header when they are a member of it, else their oldest membership. Convenience only — never the sole authorisation check.';

-- ---------------------------------------------------------------------------
-- Guard: a tenant must always keep exactly one reachable owner
-- ---------------------------------------------------------------------------
-- Without this, an admin can demote or remove the last owner and permanently
-- orphan the store — nobody left who can manage billing or delete it.
create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := coalesce(old.tenant_id, new.tenant_id);
  v_owners    int;
begin
  -- Only relevant when an accepted owner stops being one.
  if old.role <> 'owner' or old.accepted_at is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.accepted_at is not null then
    return new;
  end if;

  select count(*) into v_owners
  from public.tenant_members m
  where m.tenant_id = v_tenant_id
    and m.role = 'owner'
    and m.accepted_at is not null
    and m.id <> old.id;

  if v_owners = 0 then
    raise exception 'A tenant must keep at least one owner'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger tenant_members_protect_last_owner
  before update or delete on public.tenant_members
  for each row execute function public.prevent_last_owner_removal();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.tenants        enable row level security;
alter table public.profiles       enable row level security;
alter table public.tenant_members enable row level security;
alter table public.invitations    enable row level security;

-- Even the table owner is subject to these, so a future definer function cannot
-- accidentally leak across tenants.
alter table public.tenants        force row level security;
alter table public.profiles       force row level security;
alter table public.tenant_members force row level security;
alter table public.invitations    force row level security;

-- tenants ------------------------------------------------------------------
create policy "Members read their own tenant"
  on public.tenants for select to authenticated
  using (public.is_tenant_member(id));

-- Insert goes through create_tenant(); this policy exists so a direct insert by
-- an authenticated user is still safe (they can only create, never see others).
create policy "Authenticated users may create a tenant"
  on public.tenants for insert to authenticated
  with check (auth.uid() is not null);

create policy "Admins update their tenant"
  on public.tenants for update to authenticated
  using (public.has_tenant_role(id, 'admin'))
  with check (public.has_tenant_role(id, 'admin'));

create policy "Owners delete their tenant"
  on public.tenants for delete to authenticated
  using (public.has_tenant_role(id, 'owner'));

-- profiles -----------------------------------------------------------------
create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Teammates must be visible to render "packed by", assignees, and the team list.
create policy "Users read profiles of their teammates"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.tenant_members mine
      join public.tenant_members theirs on theirs.tenant_id = mine.tenant_id
      where mine.user_id = auth.uid()
        and mine.accepted_at is not null
        and theirs.user_id = public.profiles.id
        and theirs.accepted_at is not null
    )
  );

create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No insert policy: profiles are created by the auth trigger.
-- No delete policy: removing a profile is a cascade of deleting the auth user.

-- tenant_members -----------------------------------------------------------
create policy "Members read their own membership rows"
  on public.tenant_members for select to authenticated
  using (user_id = auth.uid());

create policy "Members read the roster of their tenants"
  on public.tenant_members for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Admins add members"
  on public.tenant_members for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins change roles"
  on public.tenant_members for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins remove members"
  on public.tenant_members for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Members may leave a tenant"
  on public.tenant_members for delete to authenticated
  using (user_id = auth.uid());

-- invitations --------------------------------------------------------------
-- Note there is deliberately NO policy exposing invitations by token. Accepting
-- one goes through accept_invitation(), so a bearer token can never be used to
-- read the invitation row (and thus enumerate a tenant's other invites).
create policy "Admins read their tenant's invitations"
  on public.invitations for select to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins create invitations"
  on public.invitations for insert to authenticated
  with check (
    public.has_tenant_role(tenant_id, 'admin')
    -- Nobody may invite at a role above their own.
    and public.tenant_role_rank(role)
        <= public.tenant_role_rank(public.tenant_role_of(tenant_id))
  );

create policy "Admins update invitations"
  on public.invitations for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins revoke invitations"
  on public.invitations for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a tenant and make the caller its owner, atomically. Doing this as two
-- client round-trips risks a tenant with no owner if the second call fails.
create or replace function public.create_tenant(p_name text, p_slug text)
returns public.tenants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_slug   text := lower(btrim(p_slug));
  v_tenant public.tenants;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not public.is_valid_tenant_slug(v_slug) then
    raise exception 'Invalid store address "%" — use 3-63 characters, letters, numbers and hyphens', v_slug
      using errcode = 'check_violation';
  end if;
  if public.is_reserved_tenant_slug(v_slug) then
    raise exception 'Store address "%" is reserved', v_slug
      using errcode = 'check_violation';
  end if;

  insert into public.tenants (name, slug)
  values (btrim(p_name), v_slug)
  returning * into v_tenant;

  insert into public.tenant_members (tenant_id, user_id, role, invited_at, accepted_at)
  values (v_tenant.id, v_user, 'owner', now(), now());

  return v_tenant;
end;
$$;

comment on function public.create_tenant(text, text) is
  'Creates a tenant and its owner membership in one transaction. Returns the new tenant.';

-- Accept an invitation by token.
--
-- SECURITY DEFINER because the caller cannot (and must not) read the invitations
-- table by token. Validates expiry and that the token was issued to the caller's
-- own email, so a leaked token cannot be redeemed by a third party.
create or replace function public.accept_invitation(p_token text)
returns public.tenant_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user       uuid := auth.uid();
  v_email      text := lower(btrim(coalesce(auth.email(), '')));
  v_invitation public.invitations;
  v_member     public.tenant_members;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_invitation
  from public.invitations i
  where i.token = p_token
  for update;

  if v_invitation.id is null then
    raise exception 'Invitation not found' using errcode = 'no_data_found';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception 'Invitation already accepted' using errcode = 'check_violation';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception 'Invitation has expired' using errcode = 'check_violation';
  end if;
  if v_email = '' or v_invitation.email <> v_email then
    raise exception 'This invitation was sent to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.tenant_members (tenant_id, user_id, role, invited_at, accepted_at)
  values (v_invitation.tenant_id, v_user, v_invitation.role, v_invitation.created_at, now())
  on conflict (tenant_id, user_id) do update
    set accepted_at = coalesce(public.tenant_members.accepted_at, now())
  returning * into v_member;

  update public.invitations set accepted_at = now() where id = v_invitation.id;

  return v_member;
end;
$$;

comment on function public.accept_invitation(text) is
  'Redeems an invitation token for the current user. Requires the token to match the caller''s own email.';

-- The tenants a user can switch between, with their role. One round trip for the
-- tenant switcher instead of a join the client has to assemble.
create or replace function public.my_tenants()
returns table (
  id            uuid,
  name          text,
  slug          text,
  logo_path     text,
  brand_color   text,
  status        text,
  role          public.tenant_role,
  joined_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.slug, t.logo_path, t.brand_color, t.status,
         m.role, m.accepted_at
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid()
    and m.accepted_at is not null
  order by m.created_at, m.id;
$$;

comment on function public.my_tenants() is
  'Tenants the current user belongs to, for the tenant switcher.';

-- ---------------------------------------------------------------------------
-- Public storefront projection
-- ---------------------------------------------------------------------------
-- The storefront resolves {slug}.selld.ph anonymously, so it needs slug -> tenant
-- without being a member. RLS is row-level, not column-level, so instead of
-- loosening the tenants policy this view exposes an explicit, minimal column set.
--
-- security_invoker is deliberately LEFT OFF here (unlike psgc_address_units):
-- the view runs as its owner and intentionally bypasses the tenants RLS policy.
-- That is safe only because every column below is public storefront branding.
-- Never add a column to this view without re-reading that sentence.
create view public.storefront_tenants as
select
  t.id,
  t.name,
  t.slug,
  t.custom_domain,
  t.logo_path,
  t.brand_color,
  t.locale
from public.tenants t
where t.status = 'active';

comment on view public.storefront_tenants is
  'Public, minimal projection of active tenants for anonymous storefront rendering. Intentionally bypasses tenants RLS — public branding columns only.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.tenants        to authenticated;
grant select, update                 on public.profiles       to authenticated;
grant select, insert, update, delete on public.tenant_members to authenticated;
grant select, insert, update, delete on public.invitations    to authenticated;

grant select on public.storefront_tenants to anon, authenticated;

grant execute on function public.is_tenant_member(uuid)                        to authenticated;
grant execute on function public.tenant_role_of(uuid)                          to authenticated;
grant execute on function public.has_tenant_role(uuid, public.tenant_role)     to authenticated;
grant execute on function public.current_tenant_id()                           to authenticated;
grant execute on function public.tenant_role_rank(public.tenant_role)          to authenticated, anon;
grant execute on function public.is_valid_tenant_slug(text)                    to authenticated, anon;
grant execute on function public.is_reserved_tenant_slug(text)                 to authenticated, anon;
grant execute on function public.create_tenant(text, text)                     to authenticated;
grant execute on function public.accept_invitation(text)                       to authenticated;
grant execute on function public.my_tenants()                                  to authenticated;

-- anon gets nothing on the base tables. The storefront reads the view only.
revoke all on public.tenants        from anon;
revoke all on public.profiles       from anon;
revoke all on public.tenant_members from anon;
revoke all on public.invitations    from anon;
