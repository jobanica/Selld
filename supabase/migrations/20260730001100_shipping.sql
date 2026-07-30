-- ---------------------------------------------------------------------------
-- Phase 7 — shipping configuration
-- ---------------------------------------------------------------------------
-- Done when a seller can express "₱80 Davao City, ₱150 Mindanao, ₱200 rest of PH,
-- free over ₱2,000" without touching code. That sentence is the specification:
-- three zones at three different levels of the PSGC hierarchy, a catch-all, and a
-- threshold that overrides all of them.
--
-- DEVIATION FROM THE BRIEF, deliberate. The schema sketch says
-- `shipping_zones.match_rules JSONB (region/province/city lists)`. This uses a
-- child table with real foreign keys into PSGC instead.
--
-- The reason is a bug from the phase immediately before this one: `orders.shipping_address`
-- is a JSONB snapshot, and because JSONB has no foreign keys, "the field is
-- non-empty" accepted a *region* code posted into the city slot and produced an
-- order no courier could deliver. A zone whose match rules live in JSONB has
-- exactly that shape — a typo'd or stale city code is representable, and the
-- failure mode is silent: the zone simply never matches, so every buyer in that
-- city quietly falls through to the catch-all rate. Having just been burned by it,
-- using JSONB here again would be repeating a known mistake on purpose.

-- ---------------------------------------------------------------------------
-- Zones
-- ---------------------------------------------------------------------------
create table public.shipping_zones (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  -- The catch-all. Exactly one per tenant, enforced below — a seller with two
  -- "rest of PH" zones has an ambiguous quote, and a seller with none has buyers
  -- who cannot check out from anywhere unlisted.
  is_default boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, name)
);

create index shipping_zones_tenant_idx on public.shipping_zones (tenant_id, sort_order);

create unique index shipping_zones_one_default_idx
  on public.shipping_zones (tenant_id) where is_default;

create trigger shipping_zones_set_updated_at
  before update on public.shipping_zones
  for each row execute function public.set_updated_at();

comment on table public.shipping_zones is
  'Named delivery areas. Exactly one zone per tenant may be the catch-all (is_default).';

-- ---------------------------------------------------------------------------
-- What a zone covers
-- ---------------------------------------------------------------------------
-- One row per PSGC unit. `level` is redundant with which code column is set, and
-- that redundancy is the point: it makes the resolver's specificity ordering a
-- column it can sort on rather than a CASE over three nullable columns.
create table public.shipping_zone_areas (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  zone_id       uuid not null,
  level         text not null check (level in ('region', 'province', 'city')),

  region_code   text references public.psgc_regions (code),
  province_code text references public.psgc_provinces (code),
  city_code     text references public.psgc_cities (code),

  created_at    timestamptz not null default now(),

  foreign key (tenant_id, zone_id)
    references public.shipping_zones (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade,

  -- Exactly one code, matching `level`. Without this a row could claim to be a
  -- city rule while carrying only a region code, and the resolver would rank it as
  -- specific while matching nothing.
  constraint shipping_zone_areas_level_matches_code check (
    (level = 'region'   and region_code   is not null and province_code is null and city_code is null)
    or (level = 'province' and province_code is not null and region_code is null and city_code is null)
    or (level = 'city'     and city_code     is not null and region_code is null and province_code is null)
  )
);

create unique index shipping_zone_areas_region_idx
  on public.shipping_zone_areas (tenant_id, region_code) where region_code is not null;
create unique index shipping_zone_areas_province_idx
  on public.shipping_zone_areas (tenant_id, province_code) where province_code is not null;
create unique index shipping_zone_areas_city_idx
  on public.shipping_zone_areas (tenant_id, city_code) where city_code is not null;

create index shipping_zone_areas_zone_idx on public.shipping_zone_areas (zone_id);

comment on table public.shipping_zone_areas is
  'PSGC units covered by a zone, with real FKs so an unknown code cannot be stored. Unique per tenant per unit: one place cannot be in two zones.';

-- ---------------------------------------------------------------------------
-- Rates
-- ---------------------------------------------------------------------------
create table public.shipping_rates (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  zone_id             uuid not null,
  name                text not null check (length(btrim(name)) between 1 and 80),

  rate_type           text not null
                        check (rate_type in ('flat', 'weight_tiered', 'courier_live')),

  -- Used by `flat`, and as the fallback for `courier_live` until phase 10 can
  -- actually quote. A rate that cannot produce a number is a checkout that cannot
  -- finish.
  flat_centavos       public.centavos check (flat_centavos is null or flat_centavos >= 0),

  -- A modifier on ANY rate type, not a fourth type. "₱200 rest of PH, free over
  -- ₱2,000" is one rate with a threshold, not two rates that have to be kept
  -- consistent — and modelling it as a type would make "free over ₱2,000 on the
  -- weight-tiered zone" inexpressible.
  free_over_centavos  public.centavos check (free_over_centavos is null or free_over_centavos > 0),

  is_active           boolean not null default true,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, zone_id)
    references public.shipping_zones (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade,

  -- A flat rate must have an amount. Enforced here rather than trusted from the UI.
  constraint shipping_rates_flat_needs_amount
    check (rate_type <> 'flat' or flat_centavos is not null)
);

create index shipping_rates_zone_idx on public.shipping_rates (zone_id, sort_order);

create trigger shipping_rates_set_updated_at
  before update on public.shipping_rates
  for each row execute function public.set_updated_at();

create table public.shipping_weight_tiers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  rate_id        uuid not null,
  -- NULL means "and above" — the open-ended top tier. Without one, a parcel
  -- heavier than the heaviest tier has no price and the buyer cannot check out.
  up_to_grams    int check (up_to_grams is null or up_to_grams > 0),
  price_centavos public.centavos not null check (price_centavos >= 0),
  created_at     timestamptz not null default now(),

  foreign key (tenant_id, rate_id)
    references public.shipping_rates (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index shipping_weight_tiers_rate_idx
  on public.shipping_weight_tiers (rate_id, up_to_grams nulls last);

-- At most one open-ended tier per rate; two would make the price ambiguous.
create unique index shipping_weight_tiers_one_open_idx
  on public.shipping_weight_tiers (rate_id) where up_to_grams is null;

comment on table public.shipping_weight_tiers is
  'Ascending weight bands for a weight_tiered rate. up_to_grams NULL is the open-ended top band.';

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------
-- Which zone covers an address, and what it charges.
--
-- Specificity, most specific first: city, then province, then region, then the
-- catch-all. That ordering is the whole point of the done-when sentence — "₱80
-- Davao City" has to beat "₱150 Mindanao", which has to beat "₱200 rest of PH",
-- and Davao City is inside a Mindanao region so both genuinely match.
--
-- Province is matched on the address's own province_code, which is NULL for NCR
-- and three independent cities. That is handled by the `is not null` guard rather
-- than by pretending those places have a province — a province rule simply cannot
-- match them, and their city or region rule does.
create or replace function public.resolve_shipping_zone(
  p_tenant_id     uuid,
  p_region_code   text,
  p_province_code text,
  p_city_code     text
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select zone_id
  from (
    select a.zone_id,
           case a.level when 'city' then 3 when 'province' then 2 else 1 end as specificity,
           z.sort_order
    from public.shipping_zone_areas a
      join public.shipping_zones z on z.id = a.zone_id
    where a.tenant_id = p_tenant_id
      and (
        (a.level = 'city'     and a.city_code = p_city_code)
        or (a.level = 'province' and p_province_code is not null
            and a.province_code = p_province_code)
        or (a.level = 'region'   and a.region_code = p_region_code)
      )

    union all

    -- The catch-all, at specificity 0 so any real rule outranks it.
    select z.id, 0, z.sort_order
    from public.shipping_zones z
    where z.tenant_id = p_tenant_id and z.is_default
  ) matches
  order by specificity desc, sort_order, zone_id
  limit 1;
$$;

comment on function public.resolve_shipping_zone(uuid, text, text, text) is
  'Most specific zone covering an address: city > province > region > default.';

/**
 * The shipping charge for a cart going to a given address.
 *
 * Returns a jsonb document rather than a bare amount so the checkout page can tell
 * the buyer *which* rate applied and whether free shipping kicked in — "₱200" with
 * no explanation is what makes a buyer abandon, and "Free over ₱2,000 (you saved
 * ₱200)" is what makes them add another item.
 */
create or replace function public.quote_shipping(
  p_tenant_id     uuid,
  p_region_code   text,
  p_province_code text,
  p_city_code     text,
  p_subtotal      bigint,
  p_weight_grams  int default 0
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_zone_id uuid;
  v_zone    record;
  v_rate    record;
  v_amount  bigint;
  v_free    boolean := false;
begin
  v_zone_id := public.resolve_shipping_zone(p_tenant_id, p_region_code, p_province_code, p_city_code);

  -- No zones configured at all. Fall back to phase 6's flat setting so a store
  -- mid-setup still takes orders instead of failing every checkout.
  if v_zone_id is null then
    return jsonb_build_object(
      'zoneId', null,
      'zoneName', null,
      'rateName', null,
      'rateType', 'flat',
      'amount', coalesce((
        select (value #>> '{}')::bigint from public.tenant_settings
        where tenant_id = p_tenant_id and key = 'shipping.flat_centavos'), 0),
      'freeApplied', false,
      'source', 'setting_fallback'
    );
  end if;

  select * into v_zone from public.shipping_zones where id = v_zone_id;

  -- First active rate by the seller's own ordering. Sellers with several rates in
  -- one zone mean it deliberately; picking the cheapest would silently override
  -- what they arranged.
  select * into v_rate
  from public.shipping_rates
  where zone_id = v_zone_id and is_active
  order by sort_order, created_at
  limit 1;

  if v_rate.id is null then
    -- A zone with no rate is a configuration gap, not a free delivery. Say so, so
    -- the dashboard can flag it, and charge the tenant's flat fallback meanwhile.
    return jsonb_build_object(
      'zoneId', v_zone.id,
      'zoneName', v_zone.name,
      'rateName', null,
      'rateType', 'flat',
      'amount', coalesce((
        select (value #>> '{}')::bigint from public.tenant_settings
        where tenant_id = p_tenant_id and key = 'shipping.flat_centavos'), 0),
      'freeApplied', false,
      'source', 'zone_without_rate'
    );
  end if;

  if v_rate.rate_type = 'weight_tiered' then
    -- Lowest band whose ceiling the parcel fits under; the open-ended band (NULL)
    -- sorts last and catches everything heavier.
    select price_centavos into v_amount
    from public.shipping_weight_tiers
    where rate_id = v_rate.id
      and (up_to_grams is null or up_to_grams >= greatest(coalesce(p_weight_grams, 0), 0))
    order by up_to_grams nulls last
    limit 1;

    -- A weight rate with no band covering this parcel. Fall back to the rate's own
    -- flat amount if it has one, then to zero, rather than returning NULL and
    -- breaking the arithmetic downstream.
    v_amount := coalesce(v_amount, v_rate.flat_centavos, 0);
  else
    -- `flat`, and `courier_live` until phase 10 can quote a courier for real.
    v_amount := coalesce(v_rate.flat_centavos, 0);
  end if;

  -- The threshold, applied last so it overrides whatever the band or flat produced.
  if v_rate.free_over_centavos is not null
     and coalesce(p_subtotal, 0) >= v_rate.free_over_centavos then
    v_amount := 0;
    v_free := true;
  end if;

  return jsonb_build_object(
    'zoneId',       v_zone.id,
    'zoneName',     v_zone.name,
    'rateName',     v_rate.name,
    'rateType',     v_rate.rate_type,
    'amount',       v_amount,
    'freeApplied',  v_free,
    'freeOver',     v_rate.free_over_centavos,
    'source',       'zone'
  );
end;
$$;

comment on function public.quote_shipping(uuid, text, text, text, bigint, int) is
  'Shipping charge for a cart to an address. Falls back to shipping.flat_centavos when a store has no zones or a zone has no rate.';

-- ---------------------------------------------------------------------------
-- cart_pricing, now zone-aware
-- ---------------------------------------------------------------------------
-- Phase 6 promised that phase 7 would replace the *resolver* and not the checkout
-- flow. This is that replacement.
--
-- Two additions beyond zones:
--
-- 1. **The address is a parameter.** Shipping cannot be known before a destination
--    is. The cart page has no address yet, so it passes nulls and gets the
--    catch-all zone's price back with `shippingEstimated: true` — an honest
--    estimate the page can label rather than a number that changes at checkout
--    without explanation.
--
-- 2. **Per-product COD blocking is enforced.** `products.is_cod_allowed` has
--    existed since phase 3 and nothing read it: a seller could mark a fragile item
--    "no COD" and phase 6's checkout would cheerfully take a COD order for it.
--    `codAllowed` is now computed from the cart's actual contents, and
--    `checkout_place_order` refuses.
-- Drop the two-argument version FIRST. `create or replace` only replaces a
-- function with the same argument list, so adding defaulted parameters creates an
-- *overload* — and `cart_pricing(uuid, text)` then resolves to neither:
-- "function public.cart_pricing(uuid, unknown) is not unique". Every existing
-- caller (cart_view, checkout_place_order) would have started failing at runtime
-- while the migration itself reported success.
drop function if exists public.cart_pricing(uuid, text);

create or replace function public.cart_pricing(
  p_cart_id        uuid,
  p_payment_method text default 'cod',
  p_region_code    text default null,
  p_province_code  text default null,
  p_city_code      text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id   uuid;
  v_subtotal    bigint := 0;
  v_weight      int := 0;
  v_cod_flat    bigint := 0;
  v_cod_bps     bigint := 0;
  v_cod_fee     bigint := 0;
  v_discount    bigint := 0;
  v_items       jsonb;
  v_count       int := 0;
  v_cod_ok      boolean := true;
  v_shipping    jsonb;
  v_estimated   boolean;
begin
  select tenant_id into v_tenant_id from public.carts where id = p_cart_id;
  if v_tenant_id is null then
    return null;
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'variantId',     ci.variant_id,
      'productId',     p.id,
      'productName',   p.name,
      'productSlug',   p.slug,
      'variantLabel',  vl.label,
      'sku',           v.sku,
      'qty',           ci.qty,
      'unitPrice',     v.price_centavos,
      'lineTotal',     v.price_centavos * ci.qty,
      'snapshotPrice', ci.unit_price_centavos,
      'priceChanged',  v.price_centavos <> ci.unit_price_centavos,
      'inStock',       coalesce(a.in_stock, false),
      'codAllowed',    p.is_cod_allowed,
      'image',         img.storage_path,
      'renditions',    coalesce(to_jsonb(img.renditions), '[]'::jsonb)
    ) order by ci.created_at, ci.id), '[]'::jsonb),
    coalesce(sum(v.price_centavos * ci.qty), 0),
    coalesce(sum(ci.qty), 0),
    -- Variant weight wins, product weight is the fallback, and 0 if neither is set.
    -- A missing weight must not make a weight-tiered quote fail; it lands in the
    -- lightest band, which is the seller's problem to notice and fix.
    coalesce(sum(coalesce(v.weight_grams, p.weight_grams, 0) * ci.qty), 0),
    coalesce(bool_and(p.is_cod_allowed), true)
  into v_items, v_subtotal, v_count, v_weight, v_cod_ok
  from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id
    join public.products p on p.id = v.product_id
    left join public.storefront_availability a on a.variant_id = ci.variant_id
    left join lateral (
      select string_agg(ov.value, ' / ' order by o.sort_order) as label
      from public.product_option_values ov
        join public.product_options o on o.id = ov.option_id
      where ov.id = any (v.option_value_ids)
    ) vl on true
    left join lateral (
      select i.storage_path, i.renditions
      from public.product_images i
      where i.product_id = p.id and i.variant_id is null
      order by i.sort_order, i.id
      limit 1
    ) img on true
  where ci.cart_id = p_cart_id;

  -- With no destination yet, quote the catch-all so the cart page can show a
  -- number, and flag it as an estimate.
  v_estimated := p_city_code is null;
  v_shipping := public.quote_shipping(
    v_tenant_id, p_region_code, p_province_code, p_city_code, v_subtotal, v_weight);

  if p_payment_method = 'cod' and v_cod_ok then
    select coalesce((value #>> '{}')::bigint, 0) into v_cod_flat
    from public.tenant_settings
    where tenant_id = v_tenant_id and key = 'payments.cod_fee_centavos';

    select coalesce((value #>> '{}')::bigint, 0) into v_cod_bps
    from public.tenant_settings
    where tenant_id = v_tenant_id and key = 'payments.cod_fee_bps';

    -- Half away from zero, matching `applyBps` in src/lib/money.
    v_cod_fee := coalesce(v_cod_flat, 0)
      + round((v_subtotal::numeric * coalesce(v_cod_bps, 0)) / 10000)::bigint;
  end if;

  return jsonb_build_object(
    'cartId',        p_cart_id,
    'paymentMethod', p_payment_method,
    'itemCount',     v_count,
    'items',         v_items,
    'subtotal',      v_subtotal,
    'weightGrams',   v_weight,
    'discountTotal', v_discount,
    'shippingTotal', case when v_count = 0 then 0 else (v_shipping ->> 'amount')::bigint end,
    'shipping',      v_shipping,
    'shippingEstimated', v_estimated,
    'codFee',        case when v_count = 0 then 0 else v_cod_fee end,
    'codAllowed',    v_cod_ok,
    'grandTotal',    v_subtotal - v_discount
                     + case when v_count = 0 then 0 else (v_shipping ->> 'amount')::bigint end
                     + case when v_count = 0 then 0 else v_cod_fee end
  );
end;
$$;

comment on function public.cart_pricing(uuid, text, text, text, text) is
  'Server-side recomputation of every cart total. Shipping resolves through zones when a destination is known, and falls back to the catch-all as a labelled estimate when it is not.';

revoke all on function public.cart_pricing(uuid, text, text, text, text) from public, anon, authenticated;

-- cart_view keeps its two-argument shape; it has no address to pass.
create or replace function public.cart_view(p_token text, p_payment_method text default 'cod')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_cart_id uuid;
begin
  v_cart_id := public.cart_id_for_token(p_token);
  if v_cart_id is null then
    return null;
  end if;
  return public.cart_pricing(v_cart_id, p_payment_method);
end;
$$;

/**
 * A quote for a known destination, before the order is placed.
 *
 * This is what the checkout page calls once the buyer has picked a barangay, so the
 * shipping line stops being an estimate. It is the same `cart_pricing` the order
 * will use, with the same arguments — which is what keeps the number the buyer
 * agreed to and the number they are charged identical.
 */
create or replace function public.cart_quote_for_address(
  p_token          text,
  p_region_code    text,
  p_province_code  text,
  p_city_code      text,
  p_payment_method text default 'cod'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_cart_id uuid;
begin
  v_cart_id := public.cart_id_for_token(p_token);
  if v_cart_id is null then
    return null;
  end if;
  return public.cart_pricing(v_cart_id, p_payment_method,
                             p_region_code, p_province_code, p_city_code);
end;
$$;

grant execute on function public.cart_quote_for_address(text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- checkout_place_order, using the resolved zone rate
-- ---------------------------------------------------------------------------
-- Recreated whole rather than patched, because a function body cannot be edited in
-- place and migrations are append-only. Two changes from phase 6: the address is
-- passed to `cart_pricing` so the real zone rate applies, and the per-product COD
-- block is enforced.
create or replace function public.checkout_place_order(
  p_token          text,
  p_contact_name   text,
  p_contact_phone  text,
  p_address        jsonb,
  p_payment_method text default 'cod',
  p_contact_email  text default null,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart        record;
  v_pricing     jsonb;
  v_location_id uuid;
  v_customer_id uuid;
  v_order_id    uuid;
  v_number      text;
  v_items       jsonb;
  v_existing    uuid;
begin
  -- ---- Idempotency ------------------------------------------------------
  -- A buyer double-tapping "Place order" on a slow connection must not create two
  -- orders. The cart's status transition is the mechanism: a converted cart
  -- returns the order it already produced instead of making another.
  select o.id into v_existing
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where c.token = p_token
  limit 1;

  if v_existing is not null then
    return public.order_receipt(v_existing);
  end if;

  select * into v_cart from public.carts
  where token = p_token and status = 'active' and expires_at > now();

  if v_cart.id is null then
    raise exception 'Cart not found or already checked out' using errcode = 'no_data_found';
  end if;

  -- ---- Validate the request ---------------------------------------------
  if p_payment_method is null or p_payment_method not in ('cod','gcash','maya','card','bank','qrph') then
    raise exception 'Unsupported payment method %', p_payment_method
      using errcode = 'check_violation';
  end if;

  -- Only COD is actually live. Phase 8 brings Xendit; accepting an online method
  -- here would create an order that can never be paid.
  if p_payment_method <> 'cod' then
    raise exception 'Only cash on delivery is available right now'
      using errcode = 'feature_not_supported', hint = 'payment_method_unavailable';
  end if;

  if not coalesce((
    select (value #>> '{}')::boolean from public.tenant_settings
    where tenant_id = v_cart.tenant_id and key = 'payments.cod_enabled'
  ), true) then
    raise exception 'This store is not accepting cash on delivery'
      using errcode = 'feature_not_supported', hint = 'cod_disabled';
  end if;

  -- Per-product COD block. `products.is_cod_allowed` has existed since phase 3 and
  -- nothing read it — a seller could mark a fragile or high-value item "no COD" and
  -- checkout would take a COD order for it anyway. Checked before any stock is
  -- reserved, so a refusal costs nothing.
  if exists (
    select 1
    from public.cart_items ci
      join public.product_variants v on v.id = ci.variant_id
      join public.products p on p.id = v.product_id
    where ci.cart_id = v_cart.id and not p.is_cod_allowed
  ) then
    raise exception 'One of these items cannot be paid cash on delivery'
      using errcode = 'feature_not_supported', hint = 'cod_blocked_item';
  end if;

  if coalesce(btrim(p_contact_name), '') = '' then
    raise exception 'A name is required' using errcode = 'check_violation', hint = 'contact_name';
  end if;

  if p_contact_phone !~ '^\+63[0-9]{9,10}$' then
    raise exception 'A valid PH mobile number is required'
      using errcode = 'check_violation', hint = 'contact_phone';
  end if;

  -- Barangay is the unit couriers actually route on, and a PH address without one
  -- is undeliverable. Province is deliberately NOT required: NCR has none.
  if coalesce(p_address ->> 'barangayCode', '') = ''
     or coalesce(p_address ->> 'cityCode', '') = ''
     or coalesce(p_address ->> 'regionCode', '') = '' then
    raise exception 'A complete address is required (region, city, barangay)'
      using errcode = 'check_violation', hint = 'address_incomplete';
  end if;

  -- Present is not the same as real. The address is a JSONB snapshot, so no foreign
  -- key checks it the way `locations` is checked — and "non-empty" accepted a
  -- *region* code posted into the city field, producing an order whose address
  -- resolved to no city and no barangay at all. Undeliverable, and only visible
  -- once a rider could not find it.
  --
  -- So the codes are verified against PSGC and, critically, verified to belong to
  -- each other: a real barangay in a real city in the stated region.
  if not exists (
    select 1
    from public.psgc_barangays b
      join public.psgc_cities c on c.code = b.city_code
    where b.code = p_address ->> 'barangayCode'
      and c.code = p_address ->> 'cityCode'
      and c.region_code = p_address ->> 'regionCode'
  ) then
    raise exception 'That barangay, city and region do not go together'
      using errcode = 'check_violation', hint = 'address_incomplete';
  end if;

  -- ---- Money ------------------------------------------------------------
  -- The *resolved* address is passed in, so shipping is the real zone rate rather
  -- than the catch-all estimate the cart page showed. This is the whole point of
  -- phase 7 landing here: the number the buyer agreed to on the checkout page and
  -- the number written to the order come from one call with one set of arguments.
  v_pricing := public.cart_pricing(
    v_cart.id, p_payment_method,
    p_address ->> 'regionCode', nullif(p_address ->> 'provinceCode', ''),
    p_address ->> 'cityCode');

  if coalesce((v_pricing ->> 'itemCount')::int, 0) = 0 then
    raise exception 'Cart is empty' using errcode = 'check_violation', hint = 'empty_cart';
  end if;

  -- ---- Stock ------------------------------------------------------------
  select id into v_location_id
  from public.locations
  where tenant_id = v_cart.tenant_id
  order by is_default desc, created_at
  limit 1;

  if v_location_id is null then
    raise exception 'This store has no stock location configured'
      using errcode = 'feature_not_supported', hint = 'no_location';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('variant_id', item ->> 'variantId', 'qty', item -> 'qty')), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(v_pricing -> 'items') as item;

  -- Raises 'insufficient_stock' if any line cannot be held. Same code path — and
  -- the same sorted advisory locks — the seller-facing reserve_stock() uses.
  perform public.apply_reservation(v_cart.tenant_id, v_location_id, v_items);

  -- ---- Customer ---------------------------------------------------------
  insert into public.customers (tenant_id, name, phone, email, source)
  values (v_cart.tenant_id, btrim(p_contact_name), p_contact_phone,
          nullif(btrim(coalesce(p_contact_email, '')), ''), 'storefront')
  on conflict (tenant_id, phone) do update
    set name  = excluded.name,
        email = coalesce(excluded.email, public.customers.email)
  returning id into v_customer_id;

  -- ---- Order ------------------------------------------------------------
  v_number := public.next_order_number(v_cart.tenant_id);

  insert into public.orders (
    tenant_id, order_number, customer_id, cart_id, shipping_address,
    contact_name, contact_phone, contact_email,
    subtotal_centavos, discount_total_centavos, shipping_total_centavos,
    cod_fee_centavos, grand_total_centavos,
    payment_method, payment_status, fulfillment_status, source, notes, location_id
  ) values (
    v_cart.tenant_id, v_number, v_customer_id, v_cart.id, p_address,
    btrim(p_contact_name), p_contact_phone, nullif(btrim(coalesce(p_contact_email, '')), ''),
    (v_pricing ->> 'subtotal')::bigint,
    (v_pricing ->> 'discountTotal')::bigint,
    (v_pricing ->> 'shippingTotal')::bigint,
    (v_pricing ->> 'codFee')::bigint,
    (v_pricing ->> 'grandTotal')::bigint,
    p_payment_method, 'unpaid', 'pending', 'storefront',
    nullif(btrim(coalesce(p_notes, '')), ''), v_location_id
  )
  returning id into v_order_id;

  -- Line snapshots, including cost, so margin reporting survives a price change.
  insert into public.order_items (
    tenant_id, order_id, variant_id, product_name, variant_label, sku,
    qty, unit_price_centavos, cost_centavos, line_total_centavos
  )
  select
    v_cart.tenant_id, v_order_id, (item ->> 'variantId')::uuid,
    item ->> 'productName', item ->> 'variantLabel', item ->> 'sku',
    (item ->> 'qty')::int, (item ->> 'unitPrice')::bigint,
    v.cost_centavos, (item ->> 'lineTotal')::bigint
  from jsonb_array_elements(v_pricing -> 'items') as item
    left join public.product_variants v on v.id = (item ->> 'variantId')::uuid;

  -- ---- Retire the cart and open the audit trail -------------------------
  update public.carts
     set status = 'converted', customer_id = v_customer_id
   where id = v_cart.id;

  insert into public.order_status_history (tenant_id, order_id, field, from_status, to_status, note)
  values (v_cart.tenant_id, v_order_id, 'fulfillment_status', null, 'pending',
          'Placed by the buyer on the storefront');

  update public.customers
     set total_orders = total_orders + 1,
         total_spent_centavos = total_spent_centavos + (v_pricing ->> 'grandTotal')::bigint
   where id = v_customer_id;

  return public.order_receipt(v_order_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Presets
-- ---------------------------------------------------------------------------
-- "Metro Manila vs provincial" is the split almost every PH seller starts from, and
-- typing it by hand means picking 17 NCR cities out of a list. This seeds it.
--
-- Idempotent, and it will not touch a tenant that has already configured zones —
-- silently rewriting a seller's rates because they tapped a button twice would be
-- worse than doing nothing.
create or replace function public.seed_shipping_presets(
  p_tenant_id       uuid,
  p_metro_centavos  bigint default 8000,
  p_rest_centavos   bigint default 15000,
  p_free_over       bigint default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metro uuid;
  v_rest  uuid;
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed to configure shipping for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.shipping_zones where tenant_id = p_tenant_id) then
    return 0;
  end if;

  insert into public.shipping_zones (tenant_id, name, is_default, sort_order)
  values (p_tenant_id, 'Metro Manila', false, 0)
  returning id into v_metro;

  insert into public.shipping_zones (tenant_id, name, is_default, sort_order)
  values (p_tenant_id, 'Rest of the Philippines', true, 100)
  returning id into v_rest;

  -- NCR is one region, so one area row covers all 17 of its cities.
  insert into public.shipping_zone_areas (tenant_id, zone_id, level, region_code)
  values (p_tenant_id, v_metro, 'region', '130000000');

  insert into public.shipping_rates
    (tenant_id, zone_id, name, rate_type, flat_centavos, free_over_centavos, sort_order)
  values
    (p_tenant_id, v_metro, 'Standard', 'flat', p_metro_centavos, p_free_over, 0),
    -- The catch-all needs a rate too. A default zone without one is the same
    -- outcome as no zone at all, which is the configuration gap `quote_shipping`
    -- reports as `zone_without_rate`.
    (p_tenant_id, v_rest, 'Standard', 'flat', p_rest_centavos, p_free_over, 0);

  return 2;
end;
$$;

comment on function public.seed_shipping_presets(uuid, bigint, bigint, bigint) is
  'Seeds the Metro Manila / rest-of-PH split. No-op for a tenant that already has zones.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shipping_zones        enable row level security;
alter table public.shipping_zone_areas   enable row level security;
alter table public.shipping_rates        enable row level security;
alter table public.shipping_weight_tiers enable row level security;

alter table public.shipping_zones        force row level security;
alter table public.shipping_zone_areas   force row level security;
alter table public.shipping_rates        force row level security;
alter table public.shipping_weight_tiers force row level security;

create policy "Members read zones" on public.shipping_zones for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Admins write zones" on public.shipping_zones for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update zones" on public.shipping_zones for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete zones" on public.shipping_zones for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Members read zone areas" on public.shipping_zone_areas for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Admins write zone areas" on public.shipping_zone_areas for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update zone areas" on public.shipping_zone_areas for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete zone areas" on public.shipping_zone_areas for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Members read rates" on public.shipping_rates for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Admins write rates" on public.shipping_rates for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update rates" on public.shipping_rates for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete rates" on public.shipping_rates for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Members read tiers" on public.shipping_weight_tiers for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Admins write tiers" on public.shipping_weight_tiers for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update tiers" on public.shipping_weight_tiers for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete tiers" on public.shipping_weight_tiers for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.shipping_zones        to authenticated;
grant select, insert, update, delete on public.shipping_zone_areas   to authenticated;
grant select, insert, update, delete on public.shipping_rates        to authenticated;
grant select, insert, update, delete on public.shipping_weight_tiers to authenticated;

grant execute on function public.seed_shipping_presets(uuid, bigint, bigint, bigint) to authenticated;

-- anon never reads shipping configuration directly. A buyer gets one resolved
-- number through cart_view / cart_quote_for_address; the zone layout is the
-- seller's commercial arrangement, not something to publish.
grant execute on function public.resolve_shipping_zone(uuid, text, text, text)         to authenticated;
grant execute on function public.quote_shipping(uuid, text, text, text, bigint, int)   to authenticated;
revoke all on function public.resolve_shipping_zone(uuid, text, text, text)            from anon;
revoke all on function public.quote_shipping(uuid, text, text, text, bigint, int)      from anon;
