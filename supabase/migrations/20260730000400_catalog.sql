-- Phase 3 — catalog: categories, products, options, variants, images.
--
-- TENANT_ID ON EVERY TABLE, per hard rule 1. The build spec sketches the child
-- tables without one, but a `product_variants` row reachable only by joining up to
-- `products` means every RLS policy pays for a join and every new query is one
-- forgotten join away from a cross-tenant leak.
--
-- Carrying tenant_id denormalised raises the obvious question: what stops a child
-- row claiming a different tenant than its parent? A COMPOSITE FOREIGN KEY does.
-- Each parent gets `unique (tenant_id, id)`, and each child references
-- `(tenant_id, parent_id)`. Postgres then makes the mismatch unrepresentable —
-- no trigger, no application check, nothing to forget.
--
-- Money uses the public.centavos domain from phase 0. Stock does NOT live here:
-- inventory_levels arrives in phase 4 and is per-location, so a `stock` column on
-- a variant would be a second source of truth from the day it shipped.

-- ---------------------------------------------------------------------------
-- Slug helper
-- ---------------------------------------------------------------------------
-- Mirrors slugify() in src/lib/tenant/resolve-tenant.ts. Unlike store slugs these
-- are never hostnames, so the rules are looser — but they still must be URL-safe,
-- since they appear in storefront product URLs.
-- `unaccent` is not guaranteed present, so provide a dependency-free fallback that
-- handles the characters PH product names actually contain.
create or replace function extensions.unaccent_safe(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select translate(
    p_text,
    'áàâäãåéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
    'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC'
  );
$$;

create or replace function public.catalog_slugify(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    -- Strip accents, drop apostrophes rather than splitting on them ("Rhea's" ->
    -- "rheas"), collapse everything else to single hyphens.
    trim(both '-' from
      regexp_replace(
        regexp_replace(
          lower(extensions.unaccent_safe(p_text)),
          '[''’ʼ`]', '', 'g'
        ),
        '[^a-z0-9]+', '-', 'g'
      )
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  slug        text not null,
  -- Nested categories ("Skincare > Sunscreen"). Depth is not constrained in SQL;
  -- the UI keeps it to two levels.
  parent_id   uuid,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, slug),
  -- The composite FK is what keeps a child category in its parent's tenant.
  foreign key (tenant_id, parent_id)
    references public.categories (tenant_id, id) on delete set null
);

create index categories_tenant_idx on public.categories (tenant_id);
create index categories_parent_idx on public.categories (parent_id);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- A category cannot be its own parent. Deeper cycles are prevented by the UI
-- keeping the tree two levels deep; this catches the trivial case cheaply.
alter table public.categories
  add constraint categories_no_self_parent check (parent_id is null or parent_id <> id);

comment on table public.categories is
  'Product categories, optionally nested one level. Seeded from onboarding presets.';

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table public.products (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 200),
  slug           text not null,
  description    text,
  status         text not null default 'draft'
                   check (status in ('draft', 'active', 'archived')),
  category_id    uuid,

  -- Per-product COD block. Some sellers refuse COD on high-value or fragile
  -- items; phase 7 reads this at checkout.
  is_cod_allowed boolean not null default true,

  -- Shipping dimensions. Couriers bill on volumetric weight when it exceeds
  -- actual weight, so all four matter for accurate rates in phase 10.
  weight_grams   int check (weight_grams is null or weight_grams between 1 and 1000000),
  length_cm      int check (length_cm is null or length_cm between 1 and 500),
  width_cm       int check (width_cm is null or width_cm between 1 and 500),
  height_cm      int check (height_cm is null or height_cm between 1 and 500),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, slug),
  foreign key (tenant_id, category_id)
    references public.categories (tenant_id, id) on delete set null
);

create index products_tenant_status_idx on public.products (tenant_id, status);
create index products_category_idx on public.products (category_id);
-- Product search in the dashboard and on the storefront.
create index products_name_trgm_idx
  on public.products using gin (name extensions.gin_trgm_ops);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

comment on table public.products is
  'Sellable products. Variants carry the price; a product with no options gets one default variant.';

-- ---------------------------------------------------------------------------
-- product_options and their values  ("Size" -> S, M, L)
-- ---------------------------------------------------------------------------
create table public.product_options (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  product_id  uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 40),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),

  unique (tenant_id, id),
  -- Two "Size" options on one product is always a mistake.
  unique (product_id, name),
  foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index product_options_product_idx on public.product_options (product_id);

create table public.product_option_values (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  option_id   uuid not null,
  value       text not null check (length(btrim(value)) between 1 and 60),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),

  unique (tenant_id, id),
  unique (option_id, value),
  foreign key (tenant_id, option_id)
    references public.product_options (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index product_option_values_option_idx on public.product_option_values (option_id);

-- ---------------------------------------------------------------------------
-- product_variants — the actual sellable unit
-- ---------------------------------------------------------------------------
create table public.product_variants (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  product_id                uuid not null,

  sku                       text check (sku is null or length(btrim(sku)) between 1 and 60),
  barcode                   text check (barcode is null or length(btrim(barcode)) between 1 and 60),

  price_centavos            public.centavos not null default 0 check (price_centavos >= 0),
  -- "Was ₱999" strike-through. Must exceed price or the discount reads as a lie.
  compare_at_price_centavos public.centavos check (compare_at_price_centavos is null or compare_at_price_centavos >= 0),
  -- What the seller paid. Drives true-profit reporting in phase 18, so it is
  -- snapshotted onto order_items rather than read live at report time.
  cost_centavos             public.centavos check (cost_centavos is null or cost_centavos >= 0),

  weight_grams              int check (weight_grams is null or weight_grams between 1 and 1000000),

  -- One value per option on the product. Kept sorted by trigger so the unique
  -- index below actually catches a duplicate combination regardless of the order
  -- the client sent them in.
  option_value_ids          uuid[] not null default '{}',

  position                  int not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade,

  constraint compare_at_exceeds_price
    check (compare_at_price_centavos is null or compare_at_price_centavos > price_centavos)
);

create index product_variants_product_idx on public.product_variants (product_id);
create index product_variants_option_values_idx
  on public.product_variants using gin (option_value_ids);

-- SKU is how a seller identifies a unit on a packing slip and in a courier
-- manifest; two variants sharing one is a picking error waiting to happen.
create unique index product_variants_sku_unique
  on public.product_variants (tenant_id, sku)
  where sku is not null;

-- No two variants of a product may share an option combination.
create unique index product_variants_combination_unique
  on public.product_variants (product_id, option_value_ids);

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

-- Normalise the combination before the unique index sees it. Sorting by uuid is
-- arbitrary but deterministic, which is all uniqueness needs — display order comes
-- from joining back to product_options.sort_order, never from this array.
create or replace function public.normalize_variant_option_values()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.option_value_ids is null then
    new.option_value_ids := '{}'::uuid[];
  end if;

  select coalesce(array_agg(value order by value), '{}'::uuid[])
    into new.option_value_ids
  from unnest(new.option_value_ids) as value;

  return new;
end;
$$;

create trigger product_variants_normalize_options
  before insert or update of option_value_ids on public.product_variants
  for each row execute function public.normalize_variant_option_values();

/*
 * Validate that a variant names exactly one value for every option on its product.
 *
 * Without this, a variant can reference a value from another product, name two
 * Sizes at once, or omit Colour entirely — each of which produces a variant that
 * cannot be picked, priced, or shipped coherently, and none of which a foreign key
 * on a uuid[] can catch.
 */
create or replace function public.assert_variant_options_valid(p_variant_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_values     uuid[];
  v_expected   int;
  v_matched    int;
  v_distinct   int;
begin
  select product_id, option_value_ids into v_product_id, v_values
  from public.product_variants where id = p_variant_id;

  -- Already deleted in this transaction; nothing to check.
  if v_product_id is null then
    return;
  end if;

  select count(*) into v_expected
  from public.product_options o
  where o.product_id = v_product_id;

  -- A product with no options has exactly one variant, naming no values.
  if v_expected = 0 then
    if coalesce(array_length(v_values, 1), 0) > 0 then
      raise exception 'Variant % names option values but its product has no options', p_variant_id
        using errcode = 'check_violation';
    end if;
    return;
  end if;

  -- Every referenced value must belong to an option of THIS product.
  select count(*), count(distinct o.id)
    into v_matched, v_distinct
  from unnest(v_values) as value_id
  join public.product_option_values v on v.id = value_id
  join public.product_options o on o.id = v.option_id
  where o.product_id = v_product_id;

  if v_matched <> coalesce(array_length(v_values, 1), 0) then
    raise exception 'Variant % references option values that do not belong to its product', p_variant_id
      using errcode = 'check_violation';
  end if;

  -- One value per option: distinct options must equal the number of values...
  if v_distinct <> v_matched then
    raise exception 'Variant % names more than one value for the same option', p_variant_id
      using errcode = 'check_violation';
  end if;

  -- ...and every option must be covered.
  if v_matched <> v_expected then
    raise exception
      'Variant % names % of % options — every option needs exactly one value',
      p_variant_id, v_matched, v_expected
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Immediate, NOT deferred. Options and values necessarily exist before a variant
-- can reference their ids, so there is no ordering problem to defer around — and
-- an immediate trigger reports the failure on the statement that caused it, which
-- a deferred one cannot.
create or replace function public.validate_variant_option_values()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_variant_options_valid(new.id);
  return new;
end;
$$;

create trigger product_variants_validate_options
  after insert or update of option_value_ids, product_id on public.product_variants
  for each row execute function public.validate_variant_option_values();

/*
 * Adding or removing an option invalidates every existing variant of that product:
 * they now name the wrong number of options. Without this guard, a seller who adds
 * "Colour" to a Size-only product silently ends up with variants that violate the
 * invariant the trigger above exists to protect.
 *
 * DEFERRED on purpose, unlike the variant trigger. Regenerating the matrix is
 * legitimately a multi-statement operation — delete old variants, change options,
 * insert new ones — and checking at commit lets that happen in any order inside one
 * transaction while still refusing to let a broken catalog reach disk.
 */
create or replace function public.revalidate_product_variants()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_product_id uuid := coalesce(new.product_id, old.product_id);
  v_variant    uuid;
begin
  for v_variant in
    select id from public.product_variants where product_id = v_product_id
  loop
    perform public.assert_variant_options_valid(v_variant);
  end loop;
  return coalesce(new, old);
end;
$$;

create constraint trigger product_options_revalidate_variants
  after insert or delete on public.product_options
  deferrable initially deferred
  for each row execute function public.revalidate_product_variants();

-- ---------------------------------------------------------------------------
-- media_assets and product_images
-- ---------------------------------------------------------------------------
-- media_assets is the registry of everything a tenant has uploaded: it exists so
-- a media library and orphan cleanup are possible later. product_images is what
-- the storefront actually renders, and holds storage_path directly so showing a
-- product needs no extra join.
create table public.media_assets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  storage_path text not null,
  mime         text not null,
  size_bytes   int not null check (size_bytes > 0),
  width        int check (width is null or width > 0),
  height       int check (height is null or height > 0),
  created_at   timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, storage_path)
);

create index media_assets_tenant_idx on public.media_assets (tenant_id);

create table public.product_images (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  product_id   uuid not null,
  -- Set when the image shows one specific variant (a colourway), null when it is
  -- a general product shot.
  variant_id   uuid,
  storage_path text not null,
  alt          text,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete set null,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index product_images_product_idx on public.product_images (product_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.categories            enable row level security;
alter table public.products              enable row level security;
alter table public.product_options       enable row level security;
alter table public.product_option_values enable row level security;
alter table public.product_variants      enable row level security;
alter table public.product_images        enable row level security;
alter table public.media_assets          enable row level security;

alter table public.categories            force row level security;
alter table public.products              force row level security;
alter table public.product_options       force row level security;
alter table public.product_option_values force row level security;
alter table public.product_variants      force row level security;
alter table public.product_images        force row level security;
alter table public.media_assets          force row level security;

-- Read for any member (packers need to see what they are picking); write for
-- staff and above. A packer must never be able to change a price.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'categories', 'products', 'product_options', 'product_option_values',
    'product_variants', 'product_images', 'media_assets'
  ]
  loop
    execute format(
      $q$ create policy "Members read %1$s" on public.%1$I for select to authenticated
          using (public.is_tenant_member(tenant_id)) $q$, v_table);
    execute format(
      $q$ create policy "Staff insert %1$s" on public.%1$I for insert to authenticated
          with check (public.has_tenant_role(tenant_id, 'staff')) $q$, v_table);
    execute format(
      $q$ create policy "Staff update %1$s" on public.%1$I for update to authenticated
          using (public.has_tenant_role(tenant_id, 'staff'))
          with check (public.has_tenant_role(tenant_id, 'staff')) $q$, v_table);
    execute format(
      $q$ create policy "Staff delete %1$s" on public.%1$I for delete to authenticated
          using (public.has_tenant_role(tenant_id, 'staff')) $q$, v_table);
    execute format(
      $q$ grant select, insert, update, delete on public.%1$I to authenticated $q$, v_table);
    execute format($q$ revoke all on public.%1$I from anon $q$, v_table);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public storefront catalog projection
-- ---------------------------------------------------------------------------
-- Buyers are anonymous. Same pattern as phase 1 and 2: an explicit minimal
-- projection that intentionally bypasses RLS, rather than loosening the tables'
-- policies. Only ACTIVE products of ACTIVE tenants, and note what is NOT here —
-- cost_centavos would hand a competitor the seller's margins.
create view public.storefront_products as
select
  p.id,
  p.tenant_id,
  t.slug            as store_slug,
  p.name,
  p.slug,
  p.description,
  p.is_cod_allowed,
  p.weight_grams,
  c.name            as category_name,
  c.slug            as category_slug,
  p.created_at
from public.products p
  join public.tenants t on t.id = p.tenant_id
  left join public.categories c on c.id = p.category_id
where p.status = 'active'
  and t.status = 'active';

comment on view public.storefront_products is
  'Active products of active stores, for anonymous storefront rendering. Excludes cost_centavos by design.';

create view public.storefront_variants as
select
  v.id,
  v.product_id,
  v.tenant_id,
  v.sku,
  v.price_centavos,
  v.compare_at_price_centavos,
  v.weight_grams,
  v.option_value_ids,
  v.position
from public.product_variants v
  join public.products p on p.id = v.product_id
  join public.tenants t on t.id = v.tenant_id
where p.status = 'active'
  and t.status = 'active';

comment on view public.storefront_variants is
  'Purchasable variants of active products. cost_centavos is deliberately absent.';

create view public.storefront_product_images as
select
  i.id,
  i.product_id,
  i.variant_id,
  i.storage_path,
  i.alt,
  i.sort_order
from public.product_images i
  join public.products p on p.id = i.product_id
  join public.tenants t on t.id = i.tenant_id
where p.status = 'active'
  and t.status = 'active';

grant select on public.storefront_products       to anon, authenticated;
grant select on public.storefront_variants       to anon, authenticated;
grant select on public.storefront_product_images to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed categories from the onboarding presets
-- ---------------------------------------------------------------------------
-- Phase 2 stored the seller's chosen presets in tenant_settings['catalog.presets'].
-- This turns them into real categories, called once when the catalog is first
-- opened. Idempotent: re-running adds only what is missing.
create or replace function public.seed_categories_from_presets(
  p_tenant_id uuid,
  p_names text[]
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name    text;
  v_created int := 0;
  v_next    int;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to seed categories for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(max(sort_order), -1) + 1 into v_next
  from public.categories where tenant_id = p_tenant_id;

  foreach v_name in array p_names loop
    if public.catalog_slugify(v_name) is null then
      continue;
    end if;

    insert into public.categories (tenant_id, name, slug, sort_order)
    values (p_tenant_id, btrim(v_name), public.catalog_slugify(v_name), v_next)
    on conflict (tenant_id, slug) do nothing;

    if found then
      v_created := v_created + 1;
      v_next := v_next + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

grant execute on function public.seed_categories_from_presets(uuid, text[]) to authenticated;
grant execute on function public.catalog_slugify(text) to authenticated, anon;

comment on function public.seed_categories_from_presets(uuid, text[]) is
  'Creates categories from onboarding preset names. Idempotent; returns how many were created.';
