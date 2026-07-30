-- Phase 2 — store onboarding.
--
-- Three tables the 5-step wizard writes (tenant_settings, locations,
-- storefront_themes), plus the public storage bucket for logos.
--
-- Design note: every tenant gets default rows from a trigger the moment it is
-- created, not from the wizard. The wizard then *updates* rather than inserts.
-- That matters because a seller who abandons the wizard halfway must still have a
-- coherent tenant — a storefront with no theme row is a crash, not an empty state.

-- ---------------------------------------------------------------------------
-- tenant_settings — key/value
-- ---------------------------------------------------------------------------
-- Key/value rather than a wide table: checkout rules, COD policy, order prefix,
-- auto-confirm and packing-slip config all arrive in different phases, and
-- adding a key must not mean a migration plus a types regeneration every time.
-- Known keys are catalogued in src/lib/settings/keys.ts.
create table public.tenant_settings (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create trigger tenant_settings_set_updated_at
  before update on public.tenant_settings
  for each row execute function public.set_updated_at();

comment on table public.tenant_settings is
  'Per-tenant key/value settings. Known keys are documented in src/lib/settings/keys.ts.';

-- ---------------------------------------------------------------------------
-- locations — where stock lives and parcels ship from
-- ---------------------------------------------------------------------------
create table public.locations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  type          text not null default 'home'
                  check (type in ('warehouse', 'home', 'consignment')),
  is_default    boolean not null default false,

  -- PSGC-coded address. Codes rather than free text because couriers price and
  -- route on barangay, and shipping zones match on city (phase 7). Names are
  -- resolved by joining PSGC, so a PSA rename does not need a data migration
  -- here — unlike order addresses, which snapshot names deliberately.
  region_code    text references public.psgc_regions (code),
  province_code  text references public.psgc_provinces (code),
  city_code      text references public.psgc_cities (code),
  barangay_code  text references public.psgc_barangays (code),
  street         text,
  -- "Katabi ng Jollibee" — PH addresses lean on landmarks, not house numbers,
  -- and riders genuinely use this field.
  landmark       text,
  postal_code    text check (postal_code is null or postal_code ~ '^[0-9]{4}$'),

  -- Pickup contact for courier booking (phase 10). Falls back to the owner's
  -- profile when null.
  contact_name   text,
  contact_phone  text check (contact_phone is null or contact_phone ~ '^\+63[0-9]{9,10}$'),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index locations_tenant_idx on public.locations (tenant_id);

-- Exactly one default location per tenant. A partial unique index rather than
-- application logic, because "which location do we ship from" must never be
-- ambiguous at booking time.
create unique index locations_one_default_per_tenant
  on public.locations (tenant_id)
  where is_default;

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();

comment on table public.locations is
  'Stock locations and shipping origins. Exactly one is_default per tenant, enforced by index.';

-- ---------------------------------------------------------------------------
-- storefront_themes — one row per tenant
-- ---------------------------------------------------------------------------
create table public.storefront_themes (
  tenant_id   uuid primary key references public.tenants (id) on delete cascade,
  preset      text not null default 'clean'
                check (preset in ('clean', 'bold', 'warm', 'mono')),
  -- { "primary": "#12604f", "accent": "#f59e0b" } — validated on write below.
  colors      jsonb not null default '{}'::jsonb,
  fonts       jsonb not null default '{}'::jsonb,
  -- { "headline": "...", "subheadline": "...", "imagePath": "..." }
  hero        jsonb not null default '{}'::jsonb,
  custom_css  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger storefront_themes_set_updated_at
  before update on public.storefront_themes
  for each row execute function public.set_updated_at();

comment on table public.storefront_themes is
  'Storefront branding, one row per tenant. Created automatically with the tenant.';

-- Reject a malformed colour before it reaches the storefront, where an invalid
-- CSS value degrades to "no colour at all" and the store looks broken.
create or replace function public.validate_theme_colors()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key   text;
  v_value jsonb;
begin
  for v_key, v_value in select * from jsonb_each(new.colors) loop
    if jsonb_typeof(v_value) <> 'string'
       or (v_value #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Theme colour "%" must be a #rrggbb hex string, got %', v_key, v_value
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

create trigger storefront_themes_validate_colors
  before insert or update of colors on public.storefront_themes
  for each row execute function public.validate_theme_colors();

-- ---------------------------------------------------------------------------
-- Defaults on tenant creation
-- ---------------------------------------------------------------------------
-- Runs for every tenant however it was created, so no code path can produce a
-- tenant that the storefront or dashboard would crash on.
create or replace function public.seed_tenant_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.storefront_themes (tenant_id)
  values (new.id)
  on conflict (tenant_id) do nothing;

  insert into public.tenant_settings (tenant_id, key, value) values
    -- Onboarding progress, so an abandoned wizard resumes where it stopped.
    (new.id, 'onboarding.step', '1'::jsonb),
    (new.id, 'onboarding.completed_at', 'null'::jsonb),
    -- COD is the default because it is how most PH social commerce is paid.
    (new.id, 'payments.cod_enabled', 'true'::jsonb),
    (new.id, 'payments.cod_fee_centavos', '0'::jsonb),
    (new.id, 'payments.cod_fee_bps', '0'::jsonb),
    (new.id, 'payments.online_enabled', 'false'::jsonb),
    -- Order numbering. Sellers read these aloud on calls, so keep them short.
    (new.id, 'orders.number_prefix', '""'::jsonb),
    (new.id, 'orders.auto_confirm', 'false'::jsonb),
    (new.id, 'catalog.presets', '[]'::jsonb)
  on conflict (tenant_id, key) do nothing;

  return new;
end;
$$;

create trigger tenants_seed_defaults
  after insert on public.tenants
  for each row execute function public.seed_tenant_defaults();

-- Backfill any tenant that predates this migration.
insert into public.storefront_themes (tenant_id)
select t.id from public.tenants t
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.tenant_settings    enable row level security;
alter table public.locations          enable row level security;
alter table public.storefront_themes  enable row level security;

alter table public.tenant_settings    force row level security;
alter table public.locations          force row level security;
alter table public.storefront_themes  force row level security;

-- tenant_settings ----------------------------------------------------------
create policy "Members read settings"
  on public.tenant_settings for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Admins write settings"
  on public.tenant_settings for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins update settings"
  on public.tenant_settings for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins delete settings"
  on public.tenant_settings for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- locations ----------------------------------------------------------------
-- Staff and packers need to read locations to pick and pack; only admins may
-- change where the business ships from.
create policy "Members read locations"
  on public.locations for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Admins create locations"
  on public.locations for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins update locations"
  on public.locations for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

create policy "Admins delete locations"
  on public.locations for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- storefront_themes --------------------------------------------------------
create policy "Members read their theme"
  on public.storefront_themes for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Admins update their theme"
  on public.storefront_themes for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

-- No insert/delete policy: the row is created and removed with the tenant.

-- ---------------------------------------------------------------------------
-- Public storefront theme projection
-- ---------------------------------------------------------------------------
-- Buyers are anonymous but the store must render branded. Same reasoning as
-- storefront_tenants in phase 1: an explicit minimal projection instead of
-- loosening the table's policy. custom_css is deliberately included — it is
-- authored by the seller for their own public page.
create view public.storefront_theme_public as
select
  th.tenant_id,
  t.slug,
  th.preset,
  th.colors,
  th.fonts,
  th.hero,
  th.custom_css
from public.storefront_themes th
  join public.tenants t on t.id = th.tenant_id
where t.status = 'active';

comment on view public.storefront_theme_public is
  'Public branding for anonymous storefront rendering. Intentionally bypasses RLS — public columns only.';

-- ---------------------------------------------------------------------------
-- Storage: tenant logos and hero images
-- ---------------------------------------------------------------------------
-- One public bucket, with objects namespaced by tenant id: {tenant_id}/logo.png
-- The path prefix IS the authorisation boundary, checked in the policies below.
insert into storage.buckets (id, name)
values ('tenant-public', 'tenant-public')
on conflict (id) do nothing;

-- `public`, `file_size_limit` and `allowed_mime_types` only exist on newer
-- storage schema revisions. Set them dynamically so this migration also applies
-- to the older schema in the Postgres image CI runs against.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public') then
    execute $q$ update storage.buckets set public = true where id = 'tenant-public' $q$;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    -- 2 MB. Logos are small, and sellers upload straight from a phone camera roll
    -- where a 6 MB photo is normal — the client downscales before upload.
    execute $q$ update storage.buckets set file_size_limit = 2097152 where id = 'tenant-public' $q$;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute $q$ update storage.buckets
                set allowed_mime_types = array['image/png','image/jpeg','image/webp']
                where id = 'tenant-public' $q$;
  end if;
end;
$$;

-- Extract the tenant id from an object path, or NULL when the first segment is
-- not a uuid.
--
-- Returning NULL rather than casting inline matters: a bare `::uuid` cast on a
-- malformed path raises inside the policy, which surfaces as a 500 instead of a
-- clean denial. And `has_tenant_role(NULL, …)` is already false, so an
-- unparseable path is denied without depending on `AND` short-circuit order,
-- which Postgres does not guarantee.
create or replace function public.storage_path_tenant_id(p_name text)
returns uuid
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_first text := (storage.foldername(p_name))[1];
begin
  if v_first is null
     or v_first !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;
  return v_first::uuid;
end;
$$;

grant execute on function public.storage_path_tenant_id(text) to authenticated, anon;

-- Anyone may read: these are logos on a public storefront.
create policy "Tenant public assets are readable by anyone"
  on storage.objects for select
  using (bucket_id = 'tenant-public');

-- Writes are scoped to the tenant that owns the first path segment.
create policy "Admins upload their tenant's assets"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenant-public'
    and public.has_tenant_role(public.storage_path_tenant_id(name), 'admin')
  );

create policy "Admins replace their tenant's assets"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'tenant-public'
    and public.has_tenant_role(public.storage_path_tenant_id(name), 'admin')
  );

create policy "Admins delete their tenant's assets"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'tenant-public'
    and public.has_tenant_role(public.storage_path_tenant_id(name), 'admin')
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.tenant_settings   to authenticated;
grant select, insert, update, delete on public.locations         to authenticated;
grant select, update                 on public.storefront_themes to authenticated;

grant select on public.storefront_theme_public to anon, authenticated;

revoke all on public.tenant_settings   from anon;
revoke all on public.locations         from anon;
revoke all on public.storefront_themes from anon;
