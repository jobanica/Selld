-- ---------------------------------------------------------------------------
-- Phase 5 — image renditions
-- ---------------------------------------------------------------------------
-- Measured, not guessed: the storefront home page came in at LCP 3.2s against a
-- 2.0s budget, and the cause was not the page — it was the assets. Seven product
-- photos at 900x900 is ~500KB competing for a 1.6 Mbps link, to fill card slots
-- that are about 180 CSS px wide on a 390px viewport. Roughly five times the
-- pixels needed, for every image on the page.
--
-- The fix is `srcset`, and `srcset` needs to know which widths actually exist.
-- Deriving them by convention (guess at `foo@400.png` and hope) puts a URL in the
-- candidate list that 404s for every image uploaded before the convention
-- existed, and a 404 in srcset is a broken image rather than a graceful
-- fallback. So the widths are recorded.
--
-- `storage_path` stays the full-size original and remains the `src` fallback, so
-- a row with no renditions still renders correctly — just larger than ideal.

alter table public.product_images
  add column if not exists renditions int[] not null default '{}';

comment on column public.product_images.renditions is
  'Widths, in px, that exist alongside storage_path as {stem}@{w}.{ext}. Empty means only the original. Drives srcset.';

-- Guard the shape rather than trusting writers. A negative or absurd width would
-- produce a candidate URL that cannot exist, which is the failure mode this
-- column was added to prevent.
--
-- Via an IMMUTABLE helper because a CHECK constraint may not contain a subquery,
-- and testing "every element of an array satisfies P" otherwise needs one
-- (`not exists (select 1 from unnest(...) where not P)`). Postgres rejects that
-- with "cannot use subquery in check constraint".
create or replace function public.image_widths_are_sane(p_widths int[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(w between 16 and 4096), true) from unnest(p_widths) as w;
$$;

alter table public.product_images
  drop constraint if exists product_images_renditions_sane;
alter table public.product_images
  add constraint product_images_renditions_sane check (
    coalesce(array_length(renditions, 1), 0) <= 6
    and public.image_widths_are_sane(renditions)
  );

-- ---------------------------------------------------------------------------
-- Republish the projections that carry image data
-- ---------------------------------------------------------------------------
-- `create or replace view` cannot add a column to an existing view, so these are
-- dropped and recreated. Safe because nothing depends on them but the storefront
-- functions below, which are recreated in the same transaction.
drop view if exists public.storefront_product_images;

create view public.storefront_product_images as
select
  i.id,
  i.product_id,
  i.variant_id,
  i.storage_path,
  i.alt,
  i.sort_order,
  i.renditions
from public.product_images i
  join public.products p on p.id = i.product_id
  join public.tenants  t on t.id = i.tenant_id
where p.status = 'active'
  and t.status = 'active';

grant select on public.storefront_product_images to anon, authenticated;

-- Cards carry the rendition list so the grid can pick a small file.
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
      'compareAt',   case
                       when prices.max_compare_at > prices.max_price
                         then prices.max_compare_at
                       else null
                     end,
      'inStock',     coalesce(stock.in_stock, false),
      'image',       img.storage_path,
      'imageAlt',    img.alt,
      'renditions',  coalesce(to_jsonb(img.renditions), '[]'::jsonb)
    ) as card
    from matched m
      left join lateral (
        select min(v.price_centavos)            as min_price,
               max(v.price_centavos)            as max_price,
               max(v.compare_at_price_centavos) as max_compare_at
        from public.storefront_variants v
        where v.product_id = m.id
      ) prices on true
      left join lateral (
        select bool_or(a.in_stock) as in_stock
        from public.storefront_availability a
        where a.product_id = m.id
      ) stock on true
      left join lateral (
        select i.storage_path, i.alt, i.renditions
        from public.storefront_product_images i
        where i.product_id = m.id and i.variant_id is null
        order by i.sort_order, i.id
        limit 1
      ) img on true
  ) cards;
$$;

-- And the product page's own gallery.
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
               'path', i.storage_path, 'alt', i.alt,
               'renditions', coalesce(to_jsonb(i.renditions), '[]'::jsonb))
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
    'related', public.storefront_product_cards(v_tenant_id, null, null, 4, 0, v_product_id)
  );
end;
$$;

grant execute on function public.storefront_product_cards(uuid, text, text, int, int, uuid) to anon, authenticated;
grant execute on function public.storefront_product_page(text, text, text)                 to anon, authenticated;
