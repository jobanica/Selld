-- ---------------------------------------------------------------------------
-- Demo storefront data
-- ---------------------------------------------------------------------------
-- A realistic store to develop and measure the storefront against: "Rhea's
-- Finds" from docs/avatar.md, selling skincare + RTW, which is the actual mix
-- our avatar sells.
--
-- Run with:  pnpm seed:demo
--
-- Idempotent: re-running resets the demo tenant rather than duplicating it. It
-- writes as `postgres` (BYPASSRLS) deliberately — going through create_tenant()
-- would need a real auth user and an authenticated session, which is ceremony
-- for fixture data. Nothing here is reachable in production: the whole thing
-- keys off the `rheas-finds` slug and the script refuses to touch anything else.
--
-- Stock is inserted as ledger movements, never as inventory_levels.on_hand — the
-- same rule application code follows, because a guard trigger enforces it.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Tenant + branding
-- ---------------------------------------------------------------------------
delete from public.tenants where slug = 'rheas-finds';

insert into public.tenants (name, slug, brand_color, locale, status)
values ('Rhea''s Finds', 'rheas-finds', '#b0245f', 'tl', 'active');

-- The tenant insert trigger already created tenant_settings and a
-- storefront_themes row (but not a location — see below). Dress the theme
-- rather than re-inserting it.
update public.storefront_themes th
set preset = 'warm',
    colors = jsonb_build_object('primary', '#b0245f', 'accent', '#f4a259'),
    hero   = jsonb_build_object(
      'headline',    'Authentic skincare & RTW, direct from Rhea',
      'subheadline', 'Legit items, same-day ship sa Metro Manila. COD available nationwide.')
from public.tenants t
where t.id = th.tenant_id and t.slug = 'rheas-finds';

-- ---------------------------------------------------------------------------
-- Categories, products, variants, stock
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant     uuid;
  v_location   uuid;
  v_skincare   uuid;
  v_rtw        uuid;
  v_bags       uuid;
  v_product    uuid;
  v_variant    uuid;
  v_option     uuid;
  v_value_id   uuid;
  v_row        record;
  v_size       text;
  v_i          int;
  v_seq        int := 1;
begin
  select id into v_tenant from public.tenants where slug = 'rheas-finds';

  -- The tenant insert trigger seeds a theme and settings but NOT a location —
  -- that is the onboarding wizard's job (phase 2). This seed bypasses the
  -- wizard, so it has to create one, and it must exist before any stock
  -- movement: `location_id` is not null on the ledger.
  insert into public.locations (tenant_id, name, type, is_default, landmark)
  values (v_tenant, 'Home — Cainta', 'home', true, 'Katabi ng Jollibee Ortigas Ext.')
  returning id into v_location;

  insert into public.categories (tenant_id, name, slug, sort_order)
  values (v_tenant, 'Skincare',      'skincare', 0),
         (v_tenant, 'Ready to Wear', 'rtw',      1),
         (v_tenant, 'Bags',          'bags',     2);

  select id into v_skincare from public.categories where tenant_id = v_tenant and slug = 'skincare';
  select id into v_rtw      from public.categories where tenant_id = v_tenant and slug = 'rtw';
  select id into v_bags     from public.categories where tenant_id = v_tenant and slug = 'bags';

  -- --- Single-variant products -------------------------------------------
  -- Prices are centavos. ₱349.00 is 34900 — never 349.
  for v_row in
    select * from (values
      ('Kojic Acid Soap Bar 135g',        'kojic-acid-soap-135g',     'skincare', 14900::bigint, 19900::bigint, 60,  135),
      ('Rosehip Facial Oil 30ml',         'rosehip-facial-oil-30ml',  'skincare', 34900::bigint, null::bigint,  24,  90),
      ('Niacinamide Serum 20ml',          'niacinamide-serum-20ml',   'skincare', 39900::bigint, 49900::bigint, 3,   80),
      ('Sunscreen Gel SPF50 50ml',        'sunscreen-gel-spf50',      'skincare', 44900::bigint, null::bigint,  0,   110),
      ('Rattan Shoulder Bag',             'rattan-shoulder-bag',      'bags',     89900::bigint, 129900::bigint, 7,  620),
      ('Canvas Tote — Palm Print',        'canvas-tote-palm-print',   'bags',     54900::bigint, null::bigint,  18,  380)
    ) as t(name, slug, cat, price, compare_at, stock, grams)
  loop
    insert into public.products
      (tenant_id, name, slug, description, status, category_id, is_cod_allowed, weight_grams)
    values (
      v_tenant, v_row.name, v_row.slug,
      case v_row.cat
        when 'skincare' then 'Authentic and sealed. Bought direct from the distributor — may resibo. '
                             || 'Ships same day kapag order before 2PM.'
        else 'Hand-picked piece, good quality stitching. Ships same day kapag order before 2PM.'
      end,
      'active',
      case v_row.cat when 'skincare' then v_skincare when 'bags' then v_bags else v_rtw end,
      true, v_row.grams)
    returning id into v_product;

    -- now() is the transaction clock, so every row inserted here would otherwise
    -- share a created_at and the storefront's newest-first order would be
    -- arbitrary. Stagger them so the demo store looks like a real one.
    update public.products set created_at = now() - (v_seq || ' hours')::interval
    where id = v_product;
    v_seq := v_seq + 1;

    insert into public.product_variants
      (tenant_id, product_id, sku, price_centavos, compare_at_price_centavos, weight_grams, position)
    values (v_tenant, v_product, upper(replace(v_row.slug, '-', '')) , v_row.price, v_row.compare_at, v_row.grams, 0)
    returning id into v_variant;

    if v_row.stock > 0 then
      insert into public.stock_movements
        (tenant_id, variant_id, location_id, delta, reason, note)
      values (v_tenant, v_variant, v_location, v_row.stock, 'receive', 'Demo seed');
    end if;
  end loop;

  -- Give the low-stock product a threshold so the badge has something to fire on.
  update public.inventory_levels il
  set low_stock_threshold = 5
  from public.product_variants v
    join public.products p on p.id = v.product_id
  where il.variant_id = v.id and p.slug = 'niacinamide-serum-20ml';

  -- --- A product with options, so the variant picker has real work ---------
  insert into public.products
    (tenant_id, name, slug, description, status, category_id, is_cod_allowed, weight_grams)
  values (
    v_tenant, 'Linen Blend Blouse', 'linen-blend-blouse',
    'Breathable linen blend, hindi masikip sa braso. True to size — 5''3" wears Small. '
    || 'Available in three colors, limited stocks per size.',
    'active', v_rtw, true, 240)
  returning id into v_product;

  -- Newest product, so it leads the grid.
  update public.products set created_at = now() where id = v_product;

  insert into public.product_options (tenant_id, product_id, name, sort_order)
  values (v_tenant, v_product, 'Size', 0)
  returning id into v_option;

  v_i := 0;
  foreach v_size in array array['Small', 'Medium', 'Large'] loop
    insert into public.product_option_values (tenant_id, option_id, value, sort_order)
    values (v_tenant, v_option, v_size, v_i)
    returning id into v_value_id;

    insert into public.product_variants
      (tenant_id, product_id, sku, price_centavos, compare_at_price_centavos,
       weight_grams, option_value_ids, position)
    values (v_tenant, v_product, 'BLOUSE-' || upper(left(v_size, 1)),
            69900, 89900, 240, array[v_value_id], v_i)
    returning id into v_variant;

    -- Medium is deliberately sold out: the picker must grey it out rather than
    -- hide it, and that is only visible with a real sold-out value present.
    if v_size <> 'Medium' then
      insert into public.stock_movements
        (tenant_id, variant_id, location_id, delta, reason, note)
      values (v_tenant, v_variant, v_location, 12, 'receive', 'Demo seed');
    end if;

    v_i := v_i + 1;
  end loop;

  -- A draft product, to prove the storefront projections exclude it.
  insert into public.products (tenant_id, name, slug, description, status, category_id)
  values (v_tenant, 'Unreleased Test Item', 'unreleased-test-item',
          'Should never appear on the storefront.', 'draft', v_rtw);

  raise notice 'Demo store seeded: % active products',
    (select count(*) from public.storefront_products where tenant_id = v_tenant);
end
$$;

commit;
