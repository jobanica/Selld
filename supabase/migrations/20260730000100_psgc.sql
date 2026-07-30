-- Phase 0 — PSGC (Philippine Standard Geographic Code) reference tables.
--
-- Source: PSA, via https://psgc.gitlab.io/api/ — 17 regions, 81 provinces,
-- 1,634 cities/municipalities, 42,046 barangays.
--
-- These are PUBLIC reference data, not tenant-scoped: there is no tenant_id and
-- every authenticated or anonymous visitor may read them. RLS is still enabled
-- with an explicit read-only policy so the default-deny posture holds everywhere
-- and nothing is writable through the API.
--
-- Why barangay matters enough to carry 42k rows: couriers price and route on it,
-- COD serviceability varies by it, and a Philippine address without a barangay
-- is not a deliverable address. Free-text address fields are the single largest
-- source of RTS parcels.
--
-- Load the data with: pnpm psgc:seed  (or `pnpm db:reset`, which chains it)

-- ---------------------------------------------------------------------------
-- Regions
-- ---------------------------------------------------------------------------
create table public.psgc_regions (
  code          text primary key,
  name          text not null,
  -- "Region I", "NCR" — the numeral most Filipinos actually recognise.
  region_name   text not null,
  island_group  text not null check (island_group in ('luzon', 'visayas', 'mindanao'))
);

comment on table public.psgc_regions is 'PSGC regions (17). Public reference data.';

-- ---------------------------------------------------------------------------
-- Provinces
-- ---------------------------------------------------------------------------
create table public.psgc_provinces (
  code          text primary key,
  name          text not null,
  region_code   text not null references public.psgc_regions (code) on delete restrict,
  island_group  text not null
);

create index psgc_provinces_region_idx on public.psgc_provinces (region_code);

comment on table public.psgc_provinces is
  'PSGC provinces (81). NCR has no provinces — see psgc_cities.province_code.';

-- ---------------------------------------------------------------------------
-- Cities and municipalities
-- ---------------------------------------------------------------------------
create table public.psgc_cities (
  code             text primary key,
  -- Canonical PSA name, kept verbatim: "City of Davao", "City of Cebu".
  name             text not null,
  -- How Filipinos actually write it: "Davao City", "Cebu City". PSA naming is
  -- inconsistent ("City of Davao" but "Quezon City"), and both the checkout
  -- picker and shipping-zone matching need the colloquial form — a seller
  -- writing a rate for "Davao City" must match this row.
  display_name     text not null generated always as (
    case
      when name like 'City of %' then substring(name from 9) || ' City'
      else name
    end
  ) stored,
  old_name         text,
  is_capital       boolean not null default false,
  is_city          boolean not null default false,
  is_municipality  boolean not null default false,
  -- NULL for the 16 NCR cities/municipality and 3 independent cities (e.g.
  -- Isabela City, which sits in Region IX but belongs to no province). The
  -- address picker must therefore support region -> city directly.
  province_code    text references public.psgc_provinces (code) on delete restrict,
  district_code    text,
  region_code      text not null references public.psgc_regions (code) on delete restrict,
  island_group     text not null
);

create index psgc_cities_province_idx on public.psgc_cities (province_code);
create index psgc_cities_region_idx on public.psgc_cities (region_code);
create index psgc_cities_name_trgm_idx on public.psgc_cities using gin (name extensions.gin_trgm_ops);
create index psgc_cities_display_name_trgm_idx
  on public.psgc_cities using gin (display_name extensions.gin_trgm_ops);

comment on table public.psgc_cities is
  'PSGC cities and municipalities (1,634). province_code is NULL for NCR and independent cities.';
comment on column public.psgc_cities.province_code is
  'NULL for NCR cities and independent cities. Group these under region_code instead.';

-- ---------------------------------------------------------------------------
-- Barangays
-- ---------------------------------------------------------------------------
create table public.psgc_barangays (
  code                   text primary key,
  name                   text not null,
  old_name               text,
  -- Parent city/municipality. The PSGC API splits this across cityCode and
  -- municipalityCode; the seeder coalesces them into one column.
  city_code              text not null references public.psgc_cities (code) on delete restrict,
  -- Manila's 14 districts (Tondo, Binondo, Sampaloc, ...) are sub-municipalities.
  -- Their barangays carry BOTH city_code (City of Manila) and this code. Kept for
  -- display, since Manila buyers write the district, not the city.
  sub_municipality_code  text,
  province_code          text references public.psgc_provinces (code) on delete restrict,
  region_code            text not null references public.psgc_regions (code) on delete restrict
);

create index psgc_barangays_city_idx on public.psgc_barangays (city_code);
create index psgc_barangays_name_trgm_idx
  on public.psgc_barangays using gin (name extensions.gin_trgm_ops);

comment on table public.psgc_barangays is
  'PSGC barangays (42,046). Required for courier routing and COD serviceability.';

-- ---------------------------------------------------------------------------
-- Flattened lookup for address search and display
-- ---------------------------------------------------------------------------
-- One row per barangay with the full administrative path resolved. Used by the
-- checkout picker (phase 6) and to render address snapshots without four joins.
-- security_invoker: the view runs with the *caller's* permissions, so the RLS
-- policies on the base tables still apply. Without it a view silently becomes a
-- way around RLS — harmless for public reference data, but the habit matters
-- once tenant-scoped views appear in phase 9.
create view public.psgc_address_units
with (security_invoker = true)
as
select
  b.code            as barangay_code,
  b.name            as barangay_name,
  c.code            as city_code,
  c.name            as city_name,
  c.display_name    as city_display_name,
  c.is_city,
  p.code            as province_code,
  p.name            as province_name,
  r.code            as region_code,
  r.name            as region_name,
  r.region_name     as region_numeral,
  r.island_group,
  -- "Poblacion, Davao City, Davao del Sur" — province omitted for NCR.
  concat_ws(', ', b.name, c.display_name, p.name) as full_path
from public.psgc_barangays b
  join public.psgc_cities c on c.code = b.city_code
  left join public.psgc_provinces p on p.code = c.province_code
  join public.psgc_regions r on r.code = c.region_code;

comment on view public.psgc_address_units is
  'One row per barangay with its full administrative path. Read-only convenience view.';

-- ---------------------------------------------------------------------------
-- RLS — public read, no writes through the API
-- ---------------------------------------------------------------------------
alter table public.psgc_regions     enable row level security;
alter table public.psgc_provinces   enable row level security;
alter table public.psgc_cities      enable row level security;
alter table public.psgc_barangays   enable row level security;

create policy "PSGC regions are publicly readable"
  on public.psgc_regions for select to anon, authenticated using (true);

create policy "PSGC provinces are publicly readable"
  on public.psgc_provinces for select to anon, authenticated using (true);

create policy "PSGC cities are publicly readable"
  on public.psgc_cities for select to anon, authenticated using (true);

create policy "PSGC barangays are publicly readable"
  on public.psgc_barangays for select to anon, authenticated using (true);

-- No insert/update/delete policies: reference data changes only via migration
-- or the seeder running as the service role, which bypasses RLS.

grant select on public.psgc_regions     to anon, authenticated;
grant select on public.psgc_provinces   to anon, authenticated;
grant select on public.psgc_cities      to anon, authenticated;
grant select on public.psgc_barangays   to anon, authenticated;
grant select on public.psgc_address_units to anon, authenticated;
