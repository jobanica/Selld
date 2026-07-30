-- ---------------------------------------------------------------------------
-- Phase 5 — storefront read model
-- ---------------------------------------------------------------------------
-- The storefront is server-rendered against a hard budget: LCP < 2.0s on 3G.
-- On a 150ms-RTT link the thing that blows that budget is not payload size, it
-- is the *number of sequential round trips*. Fetching store, then theme, then
-- categories, then products, then availability is five trips — 750ms of pure
-- latency before a single byte of HTML can be written.
--
-- So each page gets exactly one function returning one jsonb document. The
-- server does one call and renders. Everything here is read-only and reads the
-- public `storefront_*` projections from phases 1–4, which already expose only
-- what a buyer may see (no cost_centavos, no exact stock counts).
--
-- These are SECURITY INVOKER on purpose. They select from views that are owned
-- by postgres and deliberately lack `security_invoker`, so the underlying tables
-- are read as the view owner. That means anon gets exactly the projections'
-- columns and nothing else — the trust boundary stays in the views, where it was
-- reviewed, instead of being re-litigated in a SECURITY DEFINER body.

-- ---------------------------------------------------------------------------
-- Host resolution
-- ---------------------------------------------------------------------------
-- A storefront is reachable two ways: `{slug}.selld.ph` and a custom domain.
-- The hostname is parsed in TypeScript (`resolveSurface`, which knows about
-- reserved slugs and is unit-tested), so this takes whichever it found.
--
-- Exactly one of the two arguments is expected to be non-null. Passing both is
-- not an error but slug wins, because a slug is always ours whereas a custom
-- domain is attacker-suppliable input in a Host header.
create index if not exists tenants_custom_domain_active_idx
  on public.tenants (lower(custom_domain))
  where custom_domain is not null and status = 'active';

create or replace function public.storefront_tenant_id(
  p_slug   text default null,
  p_domain text default null
)
returns uuid
language sql
stable
set search_path = ''
as $$
  -- Reads storefront_tenants, NOT public.tenants. anon has no grant on the base
  -- table, so selecting it here made every storefront request fail with
  -- "permission denied for table tenants" — and because this function is called
  -- first, it failed before rendering anything. The view is owner-run and
  -- already filters to status = 'active', which is why no status check remains.
  select t.id
  from public.storefront_tenants t
  where (p_slug is not null and t.slug = lower(btrim(p_slug)))
     or (p_slug is null and p_domain is not null
         and lower(t.custom_domain) = lower(btrim(p_domain)))
  limit 1;
$$;

comment on function public.storefront_tenant_id(text, text) is
  'Resolve an active tenant from a subdomain slug or a custom domain. Slug wins if both are given.';

-- ---------------------------------------------------------------------------
-- Option matrix projections
-- ---------------------------------------------------------------------------
-- The variant picker needs every option value, including sold-out ones, so it
-- can grey them out rather than hide them. Same owner-run projection pattern as
-- storefront_products: no security_invoker, active products of active stores
-- only, and nothing in these columns but names like "Size" and "Small".
create view public.storefront_product_options as
select o.id, o.product_id, o.tenant_id, o.name, o.sort_order
from public.product_options o
  join public.products p on p.id = o.product_id
  join public.tenants  t on t.id = p.tenant_id
where p.status = 'active' and t.status = 'active';

create view public.storefront_option_values as
select ov.id, ov.option_id, ov.tenant_id, ov.value, ov.sort_order
from public.product_option_values ov
  join public.product_options o on o.id = ov.option_id
  join public.products p on p.id = o.product_id
  join public.tenants  t on t.id = p.tenant_id
where p.status = 'active' and t.status = 'active';

grant select on public.storefront_product_options to anon, authenticated;
grant select on public.storefront_option_values   to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Shared fragments
-- ---------------------------------------------------------------------------
-- Store identity + branding, as the storefront head and header need it.
create or replace function public.storefront_store_json(p_tenant_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',           s.id,
    'name',         s.name,
    'slug',         s.slug,
    'customDomain', s.custom_domain,
    'logoPath',     s.logo_path,
    'brandColor',   s.brand_color,
    'locale',       s.locale,
    'theme', coalesce(
      (select jsonb_build_object(
                'preset',    th.preset,
                'colors',    th.colors,
                'fonts',     th.fonts,
                'hero',      th.hero,
                'customCss', th.custom_css)
       from public.storefront_theme_public th
       where th.tenant_id = s.id),
      '{}'::jsonb)
  )
  from public.storefront_tenants s
  where s.id = p_tenant_id;
$$;

-- A product as the grid needs it: enough to render a card, nothing more.
--
-- `priceFrom`/`priceTo` rather than a single price, because a product with
-- variants has a range and showing only the cheapest ("₱99") next to a ₱499
-- product reads as a bait-and-switch at checkout.
create or replace function public.storefront_product_cards(
  p_tenant_id uuid,
  p_category  text default null,
  p_search    text default null,
  p_limit     int default 48,
  p_offset    int default 0,
  p_exclude   uuid default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with matched as (
    select p.*,
           -- Carried into the aggregate below. jsonb_agg does not inherit a
           -- subquery's ORDER BY, and ordering the aggregate by created_at alone
           -- is unstable: products created in one transaction share a timestamp,
           -- because now() is the transaction clock, not the statement clock.
           row_number() over (order by p.created_at desc, p.id) as rn
    from public.storefront_products p
    where p.tenant_id = p_tenant_id
      and (p_exclude is null or p.id <> p_exclude)
      and (p_category is null or p.category_slug = p_category)
      and (
        p_search is null or btrim(p_search) = ''
        or p.name ilike '%' || btrim(p_search) || '%'
        or coalesce(p.description, '') ilike '%' || btrim(p_search) || '%'
      )
    order by p.created_at desc, p.id
    -- Clamped, not trusted. p_limit arrives from a query string, and an
    -- unbounded page size turns the catalog into a one-request scrape.
    limit greatest(1, least(coalesce(p_limit, 48), 96))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select coalesce(jsonb_agg(card order by rn), '[]'::jsonb)
  from (
    select m.rn, jsonb_build_object(
      'id',          m.id,
      'name',        m.name,
      'slug',        m.slug,
      'categoryName', m.category_name,
      'categorySlug', m.category_slug,
      'createdAt',   m.created_at,
      'priceFrom',   prices.min_price,
      'priceTo',     prices.max_price,
      -- Only surface a strikethrough when the compare-at is genuinely higher
      -- than what we are charging. A seller who sets them equal should not get
      -- a fake discount badge.
      'compareAt',   case
                       when prices.max_compare_at > prices.max_price
                         then prices.max_compare_at
                       else null
                     end,
      'inStock',     coalesce(stock.in_stock, false),
      'image',       img.storage_path,
      'imageAlt',    img.alt
    ) as card
    from matched m
      left join lateral (
        select min(v.price_centavos)                     as min_price,
               max(v.price_centavos)                     as max_price,
               max(v.compare_at_price_centavos)          as max_compare_at
        from public.storefront_variants v
        where v.product_id = m.id
      ) prices on true
      left join lateral (
        select bool_or(a.in_stock) as in_stock
        from public.storefront_availability a
        where a.product_id = m.id
      ) stock on true
      -- The card's image is the product's first image. `variant_id is null`
      -- keeps a variant-specific photo (e.g. one colourway) from being picked
      -- as the product's cover just because it sorts first.
      left join lateral (
        select i.storage_path, i.alt
        from public.storefront_product_images i
        where i.product_id = m.id and i.variant_id is null
        order by i.sort_order, i.id
        limit 1
      ) img on true
  ) cards;
$$;

-- ---------------------------------------------------------------------------
-- Home page — one call
-- ---------------------------------------------------------------------------
create or replace function public.storefront_home(
  p_slug     text default null,
  p_domain   text default null,
  p_category text default null,
  p_search   text default null,
  p_limit    int default 48,
  p_offset   int default 0
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.storefront_tenant_id(p_slug, p_domain);

  -- A missing store is a 404, not an error. Returning null lets the server
  -- distinguish it from a failed query and render a real not-found page.
  if v_tenant_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'store',    public.storefront_store_json(v_tenant_id),
    'products', public.storefront_product_cards(
                  v_tenant_id, p_category, p_search, p_limit, p_offset, null),
    -- Only categories that actually have something buyable in them. An empty
    -- category chip that filters to "no products" looks like a broken store.
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'slug', c.slug, 'count', c.n)
                       order by c.n desc, c.name)
      from (
        select p.category_name as name, p.category_slug as slug, count(*) as n
        from public.storefront_products p
        where p.tenant_id = v_tenant_id and p.category_slug is not null
        group by p.category_name, p.category_slug
      ) c
    ), '[]'::jsonb),
    'productCount', (
      select count(*) from public.storefront_products p where p.tenant_id = v_tenant_id
    )
  );
end;
$$;

comment on function public.storefront_home(text, text, text, text, int, int) is
  'Whole storefront home page in one round trip: store, theme, category facets, product cards.';

-- ---------------------------------------------------------------------------
-- Product page — one call
-- ---------------------------------------------------------------------------
-- Returns the option matrix as well as the variants, because the picker needs
-- to render every option value (including the ones that are sold out) and grey
-- them out. Hiding sold-out values makes a product look like it has fewer
-- choices than it does.
create or replace function public.storefront_product_page(
  p_product_slug text,
  p_slug         text default null,
  p_domain       text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tenant_id  uuid;
  v_product_id uuid;
begin
  v_tenant_id := public.storefront_tenant_id(p_slug, p_domain);
  if v_tenant_id is null then
    return null;
  end if;

  select p.id into v_product_id
  from public.storefront_products p
  where p.tenant_id = v_tenant_id and p.slug = lower(btrim(p_product_slug))
  limit 1;

  if v_product_id is null then
    -- The store exists but the product does not. Return the store anyway so the
    -- 404 page can still be branded and offer a way back into the catalog.
    return jsonb_build_object(
      'store',   public.storefront_store_json(v_tenant_id),
      'product', null
    );
  end if;

  return jsonb_build_object(
    'store', public.storefront_store_json(v_tenant_id),
    'product', (
      select jsonb_build_object(
        'id',           p.id,
        'name',         p.name,
        'slug',         p.slug,
        'description',  p.description,
        'categoryName', p.category_name,
        'categorySlug', p.category_slug,
        'isCodAllowed', p.is_cod_allowed,
        'weightGrams',  p.weight_grams,
        'createdAt',    p.created_at
      )
      from public.storefront_products p where p.id = v_product_id
    ),
    'images', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'variantId', i.variant_id,
               'path', i.storage_path, 'alt', i.alt)
             order by i.sort_order, i.id)
      from public.storefront_product_images i where i.product_id = v_product_id
    ), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'name', o.name,
               'values', coalesce((
                 select jsonb_agg(jsonb_build_object('id', ov.id, 'value', ov.value)
                                  order by ov.sort_order, ov.value)
                 from public.storefront_option_values ov where ov.option_id = o.id
               ), '[]'::jsonb))
             order by o.sort_order, o.name)
      from public.storefront_product_options o where o.product_id = v_product_id
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',            v.id,
               'sku',           v.sku,
               'price',         v.price_centavos,
               'compareAt',     case when v.compare_at_price_centavos > v.price_centavos
                                     then v.compare_at_price_centavos else null end,
               'optionValueIds', v.option_value_ids,
               'inStock',       coalesce(a.in_stock, false),
               'stockState',    coalesce(a.stock_state, 'out'))
             order by v.position, v.id)
      from public.storefront_variants v
        left join public.storefront_availability a on a.variant_id = v.id
      where v.product_id = v_product_id
    ), '[]'::jsonb),
    -- Four more products from the same store, for the "you might also like"
    -- row. Bundled here rather than fetched separately: it is below the fold,
    -- but a second round trip for it would delay hydration on a 3G link.
    -- p_exclude keeps the product you are already looking at out of its own
    -- related row.
    'related', public.storefront_product_cards(v_tenant_id, null, null, 4, 0, v_product_id)
  );
end;
$$;

comment on function public.storefront_product_page(text, text, text) is
  'Whole product page in one round trip: store, product, images, option matrix, variants with availability, related products.';

-- ---------------------------------------------------------------------------
-- Sitemap
-- ---------------------------------------------------------------------------
-- Every active product URL plus the last time anything changed, so the server
-- can emit sitemap.xml without walking the catalog in application code.
create or replace function public.storefront_sitemap(
  p_slug   text default null,
  p_domain text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.storefront_tenant_id(p_slug, p_domain);
  if v_tenant_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'slug', (select slug from public.storefront_tenants where id = v_tenant_id),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('slug', p.slug, 'updatedAt', p.created_at)
                       order by p.created_at desc)
      from public.storefront_products p where p.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(distinct p.category_slug)
      from public.storefront_products p
      where p.tenant_id = v_tenant_id and p.category_slug is not null
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- anon is the whole point: buyers are never signed in.
grant execute on function public.storefront_tenant_id(text, text)                        to anon, authenticated;
grant execute on function public.storefront_store_json(uuid)                             to anon, authenticated;
grant execute on function public.storefront_product_cards(uuid, text, text, int, int, uuid) to anon, authenticated;
grant execute on function public.storefront_home(text, text, text, text, int, int)       to anon, authenticated;
grant execute on function public.storefront_product_page(text, text, text)               to anon, authenticated;
grant execute on function public.storefront_sitemap(text, text)                          to anon, authenticated;

-- Note what is NOT here: no `grant select` to anon on product_options or
-- product_option_values. The option matrix reaches the picker through the two
-- views below, which are owner-run like every other storefront_* projection.
-- Granting the tables directly would have worked and been one line shorter, but
-- it would put a second, differently-shaped trust boundary next to the one that
-- was already reviewed.
