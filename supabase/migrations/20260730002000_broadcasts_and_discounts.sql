-- ===========================================================================
-- Phase 16 — Broadcasts, vouchers & abandoned cart
-- ===========================================================================
--
-- Phase 15 made it possible to ask "who are my quiet skincare buyers". This
-- phase is the sentence after: *and message all of them, on payday, for a price
-- I agreed to before I pressed send.*
--
-- **Done when:** a payday broadcast to 800 segmented customers sends with cost
-- shown upfront and revenue attribution shown after.
--
-- ## The shape of it
--
-- `discounts` + `discount_redemptions`   codes, auto-discounts, limits
-- `broadcasts` + `broadcast_recipients`  one send, and one row per person
-- `short_links` + `short_link_clicks`    what a buyer actually tapped
-- `abandoned_carts`                      a cart that stopped, and its nudges
--
-- ## The two numbers this phase exists for
--
-- **Before:** a seller with 800 people in a segment is about to spend real
-- money. SMS is charged per 160-character segment, an emoji or a peso sign
-- silently halves that to 70, and the difference between one segment and two on
-- 800 recipients is 800 credits. So the cost is computed from the *actual
-- message body*, per recipient, and shown before the button does anything.
--
-- **After:** "did that work" is a revenue question, and it can only be answered
-- if the link in the message is ours. Every broadcast mints a short link;
-- `short_link_clicks` records the taps, and an order placed by a recipient
-- inside the attribution window is credited to the send that preceded it.
--
-- ## What is deliberately not here
--
-- No scheduler. `broadcasts.scheduled_at` is stored and `broadcasts_due()` is
-- written, but the thing that wakes up and calls it is the same job runner
-- phases 10, 11, 13 and 14 are all waiting on. Sending is a call, and the call
-- is proved end to end; what is missing is a clock.

-- ---------------------------------------------------------------------------
-- Discounts
-- ---------------------------------------------------------------------------
/**
 * A voucher, in the four shapes a Filipino social seller actually uses.
 *
 * `percent` and `fixed` are obvious. `free_shipping` is the one that matters
 * most here: shipping is the single biggest reason a PH cart is abandoned, and
 * "free shipping today" outperforms an equivalent peso discount by enough that
 * sellers ask for it by name.
 *
 * `is_auto` is a discount with no code — it applies to every cart that qualifies.
 * That is how "₱50 off over ₱1,000" works without the buyer being told a secret
 * word, and it is why the evaluator has to be able to run with no code at all.
 */
create table public.discounts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  /** Null for an automatic discount. Stored upper-case; matched case-insensitively. */
  code text check (code is null or code ~ '^[A-Z0-9][A-Z0-9_-]{2,23}$'),
  name text not null check (length(btrim(name)) between 1 and 80),

  kind  text not null check (kind in ('percent', 'fixed', 'free_shipping')),
  /** Basis points for `percent`, centavos for `fixed`, ignored for free shipping. */
  value bigint not null default 0 check (value >= 0),

  min_subtotal_centavos public.centavos not null default 0,
  /** A ceiling on a percentage, so "20% off" cannot become ₱4,000 off. */
  max_discount_centavos public.centavos,

  usage_limit              int check (usage_limit is null or usage_limit > 0),
  usage_limit_per_customer int check (usage_limit_per_customer is null or usage_limit_per_customer > 0),
  /** Maintained by trigger from `discount_redemptions`. Never write it. */
  used_count int not null default 0,

  starts_at timestamptz,
  ends_at   timestamptz,

  is_auto   boolean not null default false,
  is_active boolean not null default true,

  /** Reserved for phase-17 targeting: categories, products, first-order-only. */
  applies_to jsonb not null default '{}'::jsonb,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  -- An automatic discount has no code to be unique on; a coded one must be
  -- unique per store or "SALE50" means two different things on one checkout.
  constraint discounts_code_or_auto check ((code is null) = is_auto)
);

create unique index discounts_code_idx on public.discounts (tenant_id, code)
  where code is not null;
create index discounts_auto_idx on public.discounts (tenant_id) where is_auto and is_active;

create trigger discounts_touch
  before update on public.discounts
  for each row execute function public.set_updated_at();

/**
 * One use of one discount, on one order.
 *
 * The row *is* the usage count — `discounts.used_count` is a projection of this
 * table maintained by trigger, for the phase-15 reason. A limit enforced against
 * a hand-incremented counter is a limit that a cancelled order quietly consumes
 * forever.
 *
 * Unique on `(discount_id, order_id)`, so replaying a checkout cannot double
 * count, and indexed on the phone because the per-customer limit is asked on
 * every single checkout that carries a code.
 */
create table public.discount_redemptions (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  discount_id uuid not null,
  order_id    uuid not null,
  customer_id uuid,
  /** Normalised, because the per-customer limit is per *person*, not per row. */
  phone text not null,

  amount_centavos public.centavos not null,
  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (discount_id, order_id),
  foreign key (tenant_id, discount_id)
    references public.discounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade
);

create index discount_redemptions_phone_idx
  on public.discount_redemptions (discount_id, phone);

create or replace function public.discounts_follow_redemptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_discount uuid := coalesce(new.discount_id, old.discount_id);
begin
  update public.discounts d
     set used_count = (select count(*)::int from public.discount_redemptions r
                       where r.discount_id = v_discount)
   where d.id = v_discount;
  return null;
end;
$$;

create trigger discounts_follow_redemptions
  after insert or delete on public.discount_redemptions
  for each row execute function public.discounts_follow_redemptions();

/**
 * Is this discount usable, right now, by this person, on this cart?
 *
 * One function, answering with an amount *and a reason*, because "invalid code"
 * is the least useful thing a checkout can say. A buyer who is ₱200 short of the
 * minimum will add ₱200 of product if you tell them; a buyer told "invalid" will
 * leave.
 *
 * Called twice on every discounted order and deliberately so: once while the
 * buyer is looking at the cart, and again inside `checkout_place_order` with the
 * phone number that only exists at checkout. Hard rule 6 — the quote the buyer
 * saw is never the thing that gets charged; the recomputation is.
 */
create or replace function public.discount_evaluate(
  p_tenant_id uuid,
  p_code      text,
  p_subtotal  bigint,
  p_shipping  bigint default 0,
  p_phone     text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d      record;
  v_amount bigint := 0;
  v_used   int;
begin
  if coalesce(btrim(p_code), '') = '' then
    return jsonb_build_object('valid', false, 'reason', 'no_code');
  end if;

  select * into v_d from public.discounts
   where tenant_id = p_tenant_id
     and code = upper(btrim(p_code))
     and is_active;

  if v_d.id is null then
    return jsonb_build_object('valid', false, 'reason', 'unknown');
  end if;
  if v_d.starts_at is not null and now() < v_d.starts_at then
    return jsonb_build_object('valid', false, 'reason', 'not_started',
                              'startsAt', v_d.starts_at);
  end if;
  if v_d.ends_at is not null and now() > v_d.ends_at then
    return jsonb_build_object('valid', false, 'reason', 'expired',
                              'endedAt', v_d.ends_at);
  end if;
  if v_d.usage_limit is not null and v_d.used_count >= v_d.usage_limit then
    return jsonb_build_object('valid', false, 'reason', 'used_up');
  end if;
  if p_subtotal < v_d.min_subtotal_centavos then
    return jsonb_build_object('valid', false, 'reason', 'below_minimum',
                              'minSubtotal', v_d.min_subtotal_centavos,
                              'shortBy', v_d.min_subtotal_centavos - p_subtotal);
  end if;

  -- Per person, and only askable once there is a person. On the cart page there
  -- is no phone number yet, so this check is the one that moves between the two
  -- calls — which is exactly why checkout re-evaluates rather than trusting.
  if v_d.usage_limit_per_customer is not null and p_phone is not null then
    select count(*)::int into v_used
    from public.discount_redemptions r
    where r.discount_id = v_d.id
      and public.ph_national_digits(r.phone) = public.ph_national_digits(p_phone);

    if v_used >= v_d.usage_limit_per_customer then
      return jsonb_build_object('valid', false, 'reason', 'already_used',
                                'limit', v_d.usage_limit_per_customer);
    end if;
  end if;

  -- The money. Integer arithmetic throughout, half away from zero, matching
  -- `applyBps` in src/lib/money — hard rule 2 applies to a voucher as much as to
  -- a price.
  if v_d.kind = 'percent' then
    v_amount := round((p_subtotal::numeric * v_d.value) / 10000)::bigint;
    if v_d.max_discount_centavos is not null then
      v_amount := least(v_amount, v_d.max_discount_centavos);
    end if;
  elsif v_d.kind = 'fixed' then
    v_amount := least(v_d.value, p_subtotal);
  else
    v_amount := greatest(coalesce(p_shipping, 0), 0);
  end if;

  return jsonb_build_object(
    'valid', true,
    'id', v_d.id,
    'code', v_d.code,
    'name', v_d.name,
    'kind', v_d.kind,
    -- `amount` is what comes off the subtotal; `shippingAmount` what comes off
    -- shipping. Kept apart because a free-shipping voucher that reduced the
    -- subtotal would make the order's own arithmetic stop adding up.
    'amount', case when v_d.kind = 'free_shipping' then 0 else v_amount end,
    'shippingAmount', case when v_d.kind = 'free_shipping' then v_amount else 0 end);
end;
$$;

/**
 * The best automatic discount for this cart, if any.
 *
 * Best by what it is worth to the buyer, not by what the seller listed first: a
 * store running "₱50 off ₱1,000" and "10% off ₱2,000" at the same time should
 * give a ₱2,500 cart the ₱250, and a seller should not have to reason about the
 * order of rows in a table.
 */
create or replace function public.discount_auto_best(
  p_tenant_id uuid,
  p_subtotal  bigint,
  p_shipping  bigint default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d    record;
  v_best jsonb := null;
  v_this jsonb;
begin
  for v_d in
    select * from public.discounts
    where tenant_id = p_tenant_id and is_auto and is_active
      and (starts_at is null or now() >= starts_at)
      and (ends_at   is null or now() <= ends_at)
      and (usage_limit is null or used_count < usage_limit)
      and p_subtotal >= min_subtotal_centavos
  loop
    v_this := case
      when v_d.kind = 'percent' then jsonb_build_object(
        'amount', least(round((p_subtotal::numeric * v_d.value) / 10000)::bigint,
                        coalesce(v_d.max_discount_centavos, 9223372036854775807::bigint)),
        'shippingAmount', 0)
      when v_d.kind = 'fixed' then jsonb_build_object(
        'amount', least(v_d.value, p_subtotal), 'shippingAmount', 0)
      else jsonb_build_object('amount', 0, 'shippingAmount', greatest(coalesce(p_shipping, 0), 0))
    end;

    v_this := v_this || jsonb_build_object(
      'valid', true, 'id', v_d.id, 'code', v_d.code, 'name', v_d.name, 'kind', v_d.kind);

    if v_best is null
       or ((v_this ->> 'amount')::bigint + (v_this ->> 'shippingAmount')::bigint)
        > ((v_best ->> 'amount')::bigint + (v_best ->> 'shippingAmount')::bigint) then
      v_best := v_this;
    end if;
  end loop;

  return v_best;
end;
$$;

-- ---------------------------------------------------------------------------
-- The one place money is computed, now that vouchers exist
-- ---------------------------------------------------------------------------
/**
 * `carts.discount_code` — the buyer's code lives on their own cart.
 *
 * Not a parameter to `cart_pricing`, which has four callers, because a discount
 * that is passed in is a discount that one of those callers will eventually
 * forget to pass. On the cart it is part of the buyer's session, and every path
 * that prices that cart sees it.
 */
alter table public.carts add column if not exists discount_code text;

/**
 * `cart_pricing`, with the discount hook filled in.
 *
 * Phase 6 left `v_discount` declared and hardwired to zero, and this is the
 * phase that fills it. Reproduced from the live definition and edited in three
 * places rather than rewritten, because rewriting it from memory is how the COD
 * gate, the payment-method check and the idempotent replay quietly go missing.
 */
CREATE OR REPLACE FUNCTION public.cart_pricing(p_cart_id uuid, p_payment_method text DEFAULT 'cod'::text, p_region_code text DEFAULT NULL::text, p_province_code text DEFAULT NULL::text, p_city_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id   uuid;
  v_subtotal    bigint := 0;
  v_weight      int := 0;
  v_cod_flat    bigint := 0;
  v_cod_bps     bigint := 0;
  v_cod_fee     bigint := 0;
  v_discount    bigint := 0;
  v_ship_disc   bigint := 0;
  v_disc_code   text;
  v_disc        jsonb;
  v_ship_amount bigint := 0;
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

  -- ---- Discounts (phase 16) ---------------------------------------------
  -- Applied here and nowhere else, because this is the one place money is
  -- computed. A voucher applied in the UI and trusted at checkout is the
  -- phase-6 snapshot trap wearing a different hat.
  v_ship_amount := case when v_count = 0 then 0 else (v_shipping ->> 'amount')::bigint end;

  if v_count > 0 then
    select discount_code into v_disc_code from public.carts where id = p_cart_id;

    v_disc := public.discount_evaluate(
      v_tenant_id, v_disc_code, v_subtotal, v_ship_amount, null);

    -- A code that has stopped being valid falls back to whatever is running for
    -- everybody, rather than to nothing: the buyer should not lose an automatic
    -- ₱50 because they pasted an expired code on top of it.
    if coalesce((v_disc ->> 'valid')::boolean, false) is not true then
      v_disc := public.discount_auto_best(v_tenant_id, v_subtotal, v_ship_amount);
    end if;

    v_discount  := coalesce((v_disc ->> 'amount')::bigint, 0);
    v_ship_disc := coalesce((v_disc ->> 'shippingAmount')::bigint, 0);
  end if;

  return jsonb_build_object(
    'cartId',        p_cart_id,
    'paymentMethod', p_payment_method,
    'itemCount',     v_count,
    'items',         v_items,
    'subtotal',      v_subtotal,
    'weightGrams',   v_weight,
    'discountTotal', v_discount + v_ship_disc,
    'discount',      v_disc,
    -- The shipping line already has the free-shipping voucher taken off it, so
    -- the receipt reads "Shipping ₱0" rather than "₱80" beside a discount the
    -- buyer has to do arithmetic on.
    'shippingTotal', greatest(v_ship_amount - v_ship_disc, 0),
    'shippingBeforeDiscount', v_ship_amount,
    'shipping',      v_shipping,
    'shippingEstimated', v_estimated,
    'codFee',        case when v_count = 0 then 0 else v_cod_fee end,
    'codAllowed',    v_cod_ok,
    'grandTotal',    v_subtotal - v_discount
                     + greatest(v_ship_amount - v_ship_disc, 0)
                     + case when v_count = 0 then 0 else v_cod_fee end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Short links
-- ---------------------------------------------------------------------------
/**
 * A link short enough to survive an SMS, and ours enough to measure.
 *
 * Both halves matter. An SMS is charged per 160 characters and a storefront URL
 * with a product path is fifty of them, so a broadcast that pastes the long URL
 * costs the seller a second segment on every recipient. And a link that is not
 * ours cannot be counted, which means "did the payday blast work" has no answer.
 *
 * The slug is short and unambiguous: no vowels, so it cannot spell anything, and
 * no `0`/`o`/`1`/`l`, because these get read aloud and typed by hand.
 */
create table public.short_links (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  slug   text not null unique check (slug ~ '^[a-z0-9]{5,12}$'),
  target text not null check (target ~ '^https?://'),

  /** What made this link, so a click can be credited back to it. */
  source_type text not null default 'broadcast'
    check (source_type in ('broadcast', 'abandoned_cart', 'tracking', 'manual')),
  source_id uuid,

  /** Maintained by trigger from `short_link_clicks`. Never write it. */
  click_count int not null default 0,

  created_at timestamptz not null default now(),
  expires_at timestamptz,

  unique (tenant_id, id)
);

create index short_links_source_idx on public.short_links (source_type, source_id);

/**
 * One tap.
 *
 * No IP address and no user agent beyond a coarse device hint. A short link is
 * followed by a person who was sent a message, and the pair (link, time) is
 * already enough to say whether the send worked — storing the rest would make
 * this table a location log of the seller's customers, held for a metric nobody
 * asked for.
 */
create table public.short_link_clicks (
  id       bigint generated always as identity primary key,
  link_id  uuid not null references public.short_links (id) on delete cascade,
  /** Set when the link was personalised, so revenue can be attributed. */
  recipient_id uuid,
  clicked_at timestamptz not null default now()
);

create index short_link_clicks_link_idx on public.short_link_clicks (link_id, clicked_at desc);

create or replace function public.short_links_follow_clicks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.short_links
     set click_count = (select count(*)::int from public.short_link_clicks
                        where link_id = new.link_id)
   where id = new.link_id;
  return null;
end;
$$;

create trigger short_links_follow_clicks
  after insert on public.short_link_clicks
  for each row execute function public.short_links_follow_clicks();

/**
 * Mint one.
 *
 * Retries on collision rather than trusting randomness: at five characters from
 * a 30-letter alphabet a busy store *will* collide eventually, and the failure
 * mode is a buyer being sent to a stranger's shop.
 */
create or replace function public.short_link_create(
  p_tenant_id   uuid,
  p_target      text,
  p_source_type text default 'broadcast',
  p_source_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_slug text;
  v_id   uuid;
  i int;
begin
  for attempt in 1..10 loop
    v_slug := '';
    for i in 1..6 loop
      v_slug := v_slug || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    begin
      insert into public.short_links (tenant_id, slug, target, source_type, source_id)
      values (p_tenant_id, v_slug, p_target, p_source_type, p_source_id)
      returning id into v_id;
      return jsonb_build_object('id', v_id, 'slug', v_slug);
    exception when unique_violation then
      -- Try again. Ten attempts at 30^6 is not a loop that runs twice.
      null;
    end;
  end loop;

  raise exception 'Could not mint a short link' using errcode = 'internal_error';
end;
$$;

/** Follow one, and count the tap. Anon — a buyer holds no session. */
create or replace function public.short_link_follow(p_slug text, p_recipient uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_link record;
begin
  select * into v_link from public.short_links where slug = lower(btrim(p_slug));
  if v_link.id is null then return null; end if;
  if v_link.expires_at is not null and now() > v_link.expires_at then
    return jsonb_build_object('target', null, 'expired', true);
  end if;

  insert into public.short_link_clicks (link_id, recipient_id)
  values (v_link.id, p_recipient);

  return jsonb_build_object('target', v_link.target, 'expired', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Broadcasts
-- ---------------------------------------------------------------------------
/**
 * One send to a segment, and what it cost and earned.
 *
 * The segment is stored as a *definition*, not as a list of ids, so a broadcast
 * saved on Tuesday and sent on payday goes to the people who qualify on payday.
 * The recipients are frozen at send time into `broadcast_recipients`, which is
 * the opposite decision for the opposite reason: after the send, "who did this
 * go to" must never change, or the revenue number moves under the seller.
 */
create table public.broadcasts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  name    text not null check (length(btrim(name)) between 1 and 80),
  channel text not null default 'auto'
    check (channel in ('sms', 'messenger', 'auto')),

  /** The same closed vocabulary phase 15's segment builder speaks. */
  segment_definition jsonb not null default '{}'::jsonb,
  segment_id uuid,

  /** Supports {{name}}, {{storeUrl}} and {{code}}. */
  body text not null check (length(btrim(body)) between 1 and 900),
  /** The voucher this blast is carrying, if any. */
  discount_id uuid,

  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,

  /** Counters, all projections of `broadcast_recipients`. Never write them. */
  recipient_count int not null default 0,
  sent_count      int not null default 0,
  failed_count    int not null default 0,
  skipped_count   int not null default 0,
  credits_spent   int not null default 0,

  short_link_id uuid,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, discount_id)
    references public.discounts (tenant_id, id) on delete set null (discount_id)
);

create index broadcasts_tenant_idx on public.broadcasts (tenant_id, created_at desc);
create index broadcasts_due_idx on public.broadcasts (scheduled_at)
  where status = 'scheduled';

create trigger broadcasts_touch
  before update on public.broadcasts
  for each row execute function public.set_updated_at();

/**
 * One person, on one send.
 *
 * `channel` is decided per recipient rather than per broadcast, because the
 * cheapest reachable channel is a property of the *person*: somebody who
 * messaged the Page yesterday can be reached free, and the same message to the
 * next person costs a credit. `skipped` with a reason is a first-class outcome —
 * a customer with no open messaging window and no mobile number is not a
 * failure, they are simply unreachable, and a seller counting "800 sent" needs
 * that number to be true.
 */
create table public.broadcast_recipients (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  broadcast_id uuid not null,
  customer_id  uuid,

  channel text not null check (channel in ('sms', 'messenger', 'none')),
  /** The number or PSID actually used, so a delivery report can be read. */
  address text,

  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  skip_reason text,
  error text,

  segments int not null default 0,
  credits  int not null default 0,

  provider_ref text,
  sent_at timestamptz,

  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (broadcast_id, customer_id),
  foreign key (tenant_id, broadcast_id)
    references public.broadcasts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null (customer_id)
);

create index broadcast_recipients_broadcast_idx
  on public.broadcast_recipients (broadcast_id, status);
create index broadcast_recipients_customer_idx
  on public.broadcast_recipients (tenant_id, customer_id, sent_at desc);

create or replace function public.broadcasts_follow_recipients()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_broadcast uuid := coalesce(new.broadcast_id, old.broadcast_id);
begin
  update public.broadcasts b
     set recipient_count = s.total,
         sent_count      = s.sent,
         failed_count    = s.failed,
         skipped_count   = s.skipped,
         credits_spent   = s.credits
  from (
    select count(*)::int as total,
           count(*) filter (where status = 'sent')::int as sent,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'skipped')::int as skipped,
           coalesce(sum(credits) filter (where status = 'sent'), 0)::int as credits
    from public.broadcast_recipients where broadcast_id = v_broadcast
  ) s
  where b.id = v_broadcast;
  return null;
end;
$$;

create trigger broadcasts_follow_recipients
  after insert or update or delete on public.broadcast_recipients
  for each row execute function public.broadcasts_follow_recipients();

-- ---------------------------------------------------------------------------
-- What a message costs, decided in the database
-- ---------------------------------------------------------------------------
/**
 * How many SMS segments a body takes.
 *
 * A second implementation of `segmentsFor()` in `src/core/sms/log-provider.ts`,
 * and deliberately so. The TypeScript one runs while the seller types, so the
 * count moves as they edit; this one runs when credits are actually taken, and
 * the seller's bill must not be a number the client sent us. A test walks a
 * corpus through both and fails if they ever disagree.
 *
 * The rule that surprises people: one character outside GSM-7 — an emoji, a `₱`,
 * a curly quote a phone's keyboard inserted — moves the whole message to UCS-2
 * and halves the budget from 160 to 70. On 800 recipients that is 800 extra
 * credits, which is why it is worth counting properly rather than dividing by
 * 160.
 */
create or replace function public.sms_segments(p_body text)
returns int
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_gsm7 text := E'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?'
                 '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext  text := E'^{}\\[~]|€';
  v_body text := coalesce(p_body, '');
  v_char text;
  v_len  int := 0;
  v_ucs2 boolean := false;
  v_single int;
  v_multi  int;
  i int;
begin
  for i in 1..length(v_body) loop
    v_char := substr(v_body, i, 1);
    if position(v_char in v_ext) > 0 then
      -- An extension character is sent as an escape plus the character: two
      -- septets, not one.
      v_len := v_len + 2;
    elsif position(v_char in v_gsm7) > 0 then
      v_len := v_len + 1;
    else
      v_ucs2 := true;
      v_len := v_len + 1;
    end if;
  end loop;

  if v_ucs2 then
    -- Re-measured in characters: the extension-table doubling is a GSM-7 idea
    -- and means nothing once the message is UCS-2.
    v_len := length(v_body);
  end if;

  v_single := case when v_ucs2 then 70 else 160 end;
  v_multi  := case when v_ucs2 then 67 else 153 end;

  if v_len = 0 then return 1; end if;
  if v_len <= v_single then return 1; end if;
  return ceil(v_len::numeric / v_multi)::int;
end;
$$;

-- ---------------------------------------------------------------------------
-- Phase 15's segment engine, uncapped
-- ---------------------------------------------------------------------------
/**
 * `customer_segment_match` shipped with `limit least(coalesce(p_limit, 100), 500)`,
 * which is right for a preview list and wrong for everything else that uses it.
 *
 * A *count* of a segment has to count the whole segment, and the audience a
 * broadcast freezes has to be the whole audience. With the cap in place a store
 * with 800 quiet buyers saw "500 customers" on the segment builder and — far
 * worse — would have messaged 500 of them while being told that was all of them.
 *
 * So `null` now means "everybody", and the four callers that want a total pass
 * it. The upper bound stays for a caller that asks for a number, raised to
 * 50,000: a seller with more customers than that is not going to be told about
 * it by a silent truncation either.
 *
 * Re-created here rather than edited in place, because `20260730001900` has been
 * pushed and migrations are append-only after that.
 */
create or replace function public.customer_segment_match(
  p_tenant_id  uuid,
  p_definition jsonb,
  p_limit      int default 100,
  p_offset     int default 0
)
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  total_orders int,
  delivered_orders int,
  rts_orders int,
  total_spent_centavos bigint,
  pending_spent_centavos bigint,
  last_order_at timestamptz,
  source text
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive subtree as (
    -- A seller who segments on "Skincare" means the serums under it too. Without
    -- this, a two-level catalogue silently returns nobody and looks broken.
    select c.id
    from public.categories c
    where c.tenant_id = p_tenant_id
      and c.id = nullif(p_definition ->> 'boughtCategoryId', '')::uuid
    union all
    select child.id
    from public.categories child
      join subtree s on child.parent_id = s.id
    where child.tenant_id = p_tenant_id
  )
  select
    c.id, c.name, c.phone, c.email,
    c.total_orders, c.delivered_orders, c.rts_orders,
    c.total_spent_centavos::bigint, c.pending_spent_centavos::bigint,
    c.last_order_at, c.source
  from public.customers c
  where c.tenant_id = p_tenant_id
    and (p_definition ->> 'spentAtLeast'  is null
         or c.total_spent_centavos >= (p_definition ->> 'spentAtLeast')::bigint)
    and (p_definition ->> 'spentAtMost'   is null
         or c.total_spent_centavos <= (p_definition ->> 'spentAtMost')::bigint)
    and (p_definition ->> 'ordersAtLeast' is null
         or c.total_orders >= (p_definition ->> 'ordersAtLeast')::int)
    and (p_definition ->> 'ordersAtMost'  is null
         or c.total_orders <= (p_definition ->> 'ordersAtMost')::int)
    and (p_definition ->> 'orderedWithinDays' is null
         or (c.last_order_at is not null
             and c.last_order_at >= now() - make_interval(days => (p_definition ->> 'orderedWithinDays')::int)))
    -- "Haven't ordered in 60 days" includes somebody who has never ordered at
    -- all. They are exactly who a win-back message is for, and excluding them
    -- because the column is null is the kind of quiet wrong that nobody reports.
    and (p_definition ->> 'notOrderedForDays' is null
         or c.last_order_at is null
         or c.last_order_at < now() - make_interval(days => (p_definition ->> 'notOrderedForDays')::int))
    and (p_definition ->> 'rts' is null
         or (p_definition ->> 'rts') = 'any'
         or ((p_definition ->> 'rts') = 'none' and c.rts_orders = 0)
         or ((p_definition ->> 'rts') = 'some' and c.rts_orders > 0))
    and (p_definition ->> 'source' is null or c.source = (p_definition ->> 'source'))
    and (p_definition ->> 'hasTagId' is null
         or exists (select 1 from public.customer_tag_assignments a
                    where a.customer_id = c.id
                      and a.tag_id = (p_definition ->> 'hasTagId')::uuid))
    and (p_definition ->> 'cityCode' is null
         or exists (select 1 from public.orders o
                    where o.customer_id = c.id
                      and o.fulfillment_status <> 'cancelled'
                      and o.shipping_address ->> 'cityCode' = (p_definition ->> 'cityCode')))
    and (p_definition ->> 'boughtProductId' is null
         or exists (select 1
                    from public.orders o
                      join public.order_items oi on oi.order_id = o.id
                      join public.product_variants v on v.id = oi.variant_id
                    where o.customer_id = c.id
                      and o.fulfillment_status <> 'cancelled'
                      and v.product_id = (p_definition ->> 'boughtProductId')::uuid))
    and (p_definition ->> 'boughtCategoryId' is null
         or exists (select 1
                    from public.orders o
                      join public.order_items oi on oi.order_id = o.id
                      join public.product_variants v on v.id = oi.variant_id
                      join public.products p on p.id = v.product_id
                    where o.customer_id = c.id
                      and o.fulfillment_status <> 'cancelled'
                      and p.category_id in (select id from subtree)))
  order by c.total_spent_centavos desc, c.name
  -- `null` means "everybody", and it is not a convenience: a *count* of a
  -- segment, and the audience a broadcast freezes, must be the whole segment.
  -- Capping this at 500 made a store with 800 quiet buyers see "500 customers"
  -- and, worse, message 500 of them while being told it was all of them.
  limit case when p_limit is null then null
             else greatest(least(p_limit, 50000), 1) end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.customer_segment_count(
  p_tenant_id  uuid,
  p_definition jsonb
)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return (select count(*)::int
          from public.customer_segment_match(p_tenant_id, p_definition, null, 0));
end;
$$;

create or replace function public.customer_segment_preview(
  p_tenant_id  uuid,
  p_definition jsonb,
  p_limit      int default 50,
  p_offset     int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'total', (select count(*)::int
              from public.customer_segment_match(p_tenant_id, p_definition, null, 0)),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'phone', m.phone, 'email', m.email,
        'orders', m.total_orders, 'delivered', m.delivered_orders, 'rts', m.rts_orders,
        'spent', m.total_spent_centavos, 'pending', m.pending_spent_centavos,
        'lastOrderAt', m.last_order_at, 'source', m.source))
      from public.customer_segment_match(p_tenant_id, p_definition, p_limit, p_offset) m
    ), '[]'::jsonb));
end;
$$;

create or replace function public.customer_segments_list(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'description', s.description,
      'definition', s.definition, 'isPinned', s.is_pinned,
      'count', (select count(*)::int
                from public.customer_segment_match(p_tenant_id, s.definition, null, 0)),
      'updatedAt', s.updated_at)
      order by s.is_pinned desc, s.name)
    from public.customer_segments s
    where s.tenant_id = p_tenant_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Who a broadcast would reach, and what it would cost
-- ---------------------------------------------------------------------------
/**
 * The number the seller agrees to before the button does anything.
 *
 * Three groups, and the split is the point:
 *
 *   **messenger** — reachable free, because they messaged the Page inside the
 *   last 24 hours. Phase 14's window decides this, not a guess.
 *   **sms**       — reachable for credits.
 *   **none**      — unreachable, and *named* as unreachable. A seller who is
 *   told "800 recipients" and billed for 620 has been lied to twice.
 *
 * `channel = 'auto'` prefers Messenger, which is the only setting that makes
 * economic sense as a default: it is free, it is richer, and the people it
 * reaches are the ones who talked to the seller most recently.
 */
create or replace function public.broadcast_preview(
  p_tenant_id   uuid,
  p_definition  jsonb,
  p_body        text,
  p_channel     text default 'auto',
  p_discount_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_link   text;
  v_code   text;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- What actually goes down the wire is the *rendered* body, and the
  -- placeholders are not the same length as what replaces them: `{{storeUrl}}`
  -- is twelve characters in the box and about forty on the phone. Quoting the
  -- template is therefore quoting a different message from the one being sent,
  -- and the gap only appears on the bill — a 150-character draft quoted at one
  -- segment goes out as two, and 800 recipients cost twice what the seller
  -- agreed to.
  --
  -- The stand-in link is exact rather than approximate: `short_link_create`
  -- always mints six characters, so this string is the length the real one will
  -- be. The code is looked up for the same reason.
  v_link := public.tenant_store_url(p_tenant_id, null) || '/s/xxxxxx';
  if p_discount_id is not null then
    select d.code into v_code
    from public.discounts d
    where d.id = p_discount_id and d.tenant_id = p_tenant_id;
  end if;

  select jsonb_build_object(
    -- The worst case, not the average: names differ in length, so one recipient
    -- can tip into a second segment while the rest do not. A seller shown the
    -- average would be shown a number nobody is charged.
    'segments',  coalesce(max(segments) filter (where channel = 'sms'),
                          public.sms_segments(
                            public.broadcast_render(p_body, '', v_link, v_code))),
    'total',     count(*)::int,
    'messenger', count(*) filter (where channel = 'messenger')::int,
    'sms',       count(*) filter (where channel = 'sms')::int,
    'unreachable', count(*) filter (where channel = 'none')::int,
    -- Summed per recipient, so this is the exact number of credits the send
    -- will take, not a headcount multiplied by a representative length.
    'credits',   coalesce(sum(segments) filter (where channel = 'sms'), 0)::int,
    'balance',   public.sms_credit_balance_raw(p_tenant_id),
    'affordable',
      coalesce(sum(segments) filter (where channel = 'sms'), 0)
        <= public.sms_credit_balance_raw(p_tenant_id))
  into v_result
  from (
    select
      public.broadcast_channel_for(m.id, p_channel) as channel,
      public.sms_segments(public.broadcast_render(p_body, m.name, v_link, v_code))
        as segments
    from public.customer_segment_match(p_tenant_id, p_definition, null, 0) m
  ) reach;

  return v_result;
end;
$$;

/**
 * The cheapest channel that can actually reach this person.
 *
 * Asked per customer rather than per broadcast because reachability *is* per
 * customer: the 24-hour window is a property of one conversation, and a mobile
 * number is a property of one row.
 */
create or replace function public.broadcast_channel_for(
  p_customer_id uuid,
  p_channel     text default 'auto'
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_channel in ('auto', 'messenger')
         and exists (
           select 1 from public.message_threads t
           where t.customer_id = p_customer_id
             and t.last_inbound_at is not null
             and t.last_inbound_at > now() - interval '24 hours')
      then 'messenger'
    when p_channel in ('auto', 'sms')
         and exists (
           select 1 from public.customers c
           where c.id = p_customer_id
             and public.ph_national_digits(c.phone) ~ '^9[0-9]{9}$')
      then 'sms'
    else 'none'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------
/** The message this person gets, with the placeholders filled in. */
create or replace function public.broadcast_render(
  p_body     text,
  p_name     text,
  p_link     text,
  p_code     text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(coalesce(p_body, ''),
    -- First name only. "Hi Jasmine" is a message from a person; "Hi Jasmine
    -- Villanueva" is a message from a database.
    '{{name}}', coalesce(split_part(btrim(p_name), ' ', 1), '')),
    '{{storeUrl}}', coalesce(p_link, '')),
    '{{code}}', coalesce(p_code, ''));
$$;

/**
 * Freeze the audience and start sending.
 *
 * The segment is evaluated *once*, here, and written into
 * `broadcast_recipients`. Everything after this — the sending, the delivery
 * report, the revenue — reads that frozen list. A broadcast that re-evaluated
 * its segment while sending would message people who qualified halfway through
 * and would report a recipient count that changed after the fact.
 *
 * Credits are not taken here. They are taken one recipient at a time, at the
 * moment of sending, so a broadcast interrupted by a browser closing has spent
 * exactly what it sent.
 */
create or replace function public.broadcast_start(p_broadcast_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b     record;
  v_link  jsonb;
  v_url   text;
  v_code  text;
  v_count int;
begin
  select * into v_b from public.broadcasts where id = p_broadcast_id;
  if v_b.id is null then
    raise exception 'Broadcast not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_b.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_b.status not in ('draft', 'scheduled') then
    return jsonb_build_object('outcome', 'already_started', 'status', v_b.status);
  end if;

  -- One short link per broadcast, minted here so the body can carry it and the
  -- clicks can be counted against this send and no other.
  if v_b.short_link_id is null then
    v_url := public.tenant_store_url(v_b.tenant_id, null);
    v_link := public.short_link_create(v_b.tenant_id, v_url, 'broadcast', v_b.id);
    update public.broadcasts set short_link_id = (v_link ->> 'id')::uuid
     where id = p_broadcast_id;
    v_b.short_link_id := (v_link ->> 'id')::uuid;
  end if;

  -- The link and the code as the recipient will actually receive them, so the
  -- segment count frozen below is measured on the message that gets sent rather
  -- than on the template. `broadcast_preview` measures the same way; if these
  -- two ever disagree, the seller is billed something other than the number
  -- they pressed the button on.
  v_url := public.tenant_store_url(v_b.tenant_id, null) || '/s/' ||
           (select s.slug from public.short_links s where s.id = v_b.short_link_id);
  select d.code into v_code from public.discounts d where d.id = v_b.discount_id;

  insert into public.broadcast_recipients
    (tenant_id, broadcast_id, customer_id, channel, address, status, skip_reason, segments, credits)
  select
    v_b.tenant_id, v_b.id, m.id, ch.channel,
    case ch.channel
      when 'sms' then m.phone
      when 'messenger' then (select t.psid from public.message_threads t
                             where t.customer_id = m.id
                               and t.last_inbound_at > now() - interval '24 hours'
                             order by t.last_inbound_at desc limit 1)
    end,
    case when ch.channel = 'none' then 'skipped' else 'pending' end,
    case when ch.channel = 'none' then 'unreachable' end,
    case when ch.channel = 'sms'
      then public.sms_segments(public.broadcast_render(v_b.body, m.name, v_url, v_code))
      else 0 end,
    case when ch.channel = 'sms'
      then public.sms_segments(public.broadcast_render(v_b.body, m.name, v_url, v_code))
      else 0 end
  from public.customer_segment_match(v_b.tenant_id, v_b.segment_definition, null, 0) m
    cross join lateral (
      select public.broadcast_channel_for(m.id, v_b.channel) as channel
    ) ch
  on conflict (broadcast_id, customer_id) do nothing;

  get diagnostics v_count = row_count;

  update public.broadcasts
     set status = 'sending', started_at = coalesce(started_at, now())
   where id = p_broadcast_id;

  return jsonb_build_object('outcome', 'started', 'recipients', v_count);
end;
$$;

/**
 * Take the next recipient, and take their credit before anything is sent.
 *
 * The order is the whole design. Credits are moved *first*, and the send is only
 * attempted if the move succeeded — because a provider call that succeeds after
 * a credit check that passed is still a message the seller has not paid for if
 * the deduction happens afterwards and fails. `sms_credit_move` returns null
 * when the balance would go negative, and that recipient is skipped rather than
 * sent.
 *
 * One row at a time, with `for update skip locked`, so two workers on the same
 * broadcast cannot claim the same person.
 */
create or replace function public.broadcast_claim_next(p_broadcast_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b    record;
  v_r    record;
  v_link text;
  v_code text;
  v_body text;
  v_name text;
  v_balance int;
begin
  select * into v_b from public.broadcasts where id = p_broadcast_id;
  if v_b.id is null then return null; end if;

  select * into v_r
  from public.broadcast_recipients
  where broadcast_id = p_broadcast_id and status = 'pending'
  order by created_at
  for update skip locked
  limit 1;

  if v_r.id is null then
    -- Nothing left. Close the broadcast out.
    update public.broadcasts
       set status = 'sent', finished_at = coalesce(finished_at, now())
     where id = p_broadcast_id and status = 'sending';
    return null;
  end if;

  if v_r.channel = 'sms' then
    -- `send`, the same reason a tracking SMS uses. The ledger's vocabulary is
    -- about what happened to the credits, not about which screen spent them —
    -- the note carries the broadcast's name for the seller reading it back.
    v_balance := public.sms_credit_move(
      v_b.tenant_id, -v_r.credits, 'send', null,
      'Broadcast: ' || v_b.name);

    if v_balance is null then
      update public.broadcast_recipients
         set status = 'skipped', skip_reason = 'no_credits'
       where id = v_r.id;
      return jsonb_build_object('outcome', 'no_credits', 'recipientId', v_r.id);
    end if;
  end if;

  select name into v_name from public.customers where id = v_r.customer_id;
  select code into v_code from public.discounts where id = v_b.discount_id;

  v_link := case
    when v_b.short_link_id is null then public.tenant_store_url(v_b.tenant_id, null)
    else public.tenant_store_url(v_b.tenant_id, null) || '/s/' ||
         (select slug from public.short_links where id = v_b.short_link_id)
  end;

  v_body := public.broadcast_render(v_b.body, v_name, v_link, v_code);

  return jsonb_build_object(
    'recipientId', v_r.id,
    'tenantId',    v_b.tenant_id,
    'channel',     v_r.channel,
    'address',     v_r.address,
    -- A PSID without a page is not an identity, it is a number: the Send API
    -- call names the page, and the token is per page. Left out of the first
    -- version of this payload, which made every Messenger recipient come back
    -- `skipped: no_page` — free, silent, and invisible in the delivery report.
    'pageId',      (select a.page_id from public.social_accounts a
                    where a.tenant_id = v_b.tenant_id and a.platform = 'facebook'
                      and a.is_active
                    limit 1),
    'body',        v_body,
    'segments',    v_r.segments,
    'broadcastId', v_b.id);
end;
$$;

/**
 * What actually happened to that message.
 *
 * A failure refunds the credit. The alternative — charging for a message the
 * provider rejected — is the kind of arithmetic a seller finds eventually, and
 * when they do they stop trusting every other number on the screen.
 */
create or replace function public.broadcast_record_send(
  p_recipient_id uuid,
  p_status       text,
  p_provider_ref text default null,
  p_error        text default null,
  /**
   * The message as it was actually sent, placeholders and all filled in.
   *
   * Without it the log stores the *template*, and a seller reading back what
   * they sent sees `{{storeUrl}}` where the link should be — which is both
   * useless and alarming.
   */
  p_body         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r record;
  v_b record;
begin
  select * into v_r from public.broadcast_recipients where id = p_recipient_id;
  if v_r.id is null then return; end if;
  select * into v_b from public.broadcasts where id = v_r.broadcast_id;

  if p_status = 'sent' then
    -- Logged where every other outbound message is logged, so one screen answers
    -- "what has this store sent, and what did it cost".
    if v_r.channel = 'sms' then
      insert into public.sms_logs
        (tenant_id, "to", body, provider, provider_ref, status, cost_centavos,
         segments, purpose)
      values (v_r.tenant_id, v_r.address, left(coalesce(p_body, v_b.body), 900), 'broadcast',
              p_provider_ref, 'sent', 0, v_r.segments, 'broadcast');
    end if;

    update public.broadcast_recipients
       set status = 'sent', provider_ref = p_provider_ref, sent_at = now(), error = null
     where id = p_recipient_id;

  elsif p_status = 'skipped' then
    -- A channel that could not carry this message is not a failed send. The
    -- commonest case is a store whose Page is connected but whose token has
    -- expired: the seller needs to be told to reconnect, once, rather than shown
    -- 200 identical failures.
    if v_r.channel = 'sms' and v_r.credits > 0 then
      perform public.sms_credit_move(v_r.tenant_id, v_r.credits, 'refund', null,
                                     'Broadcast recipient skipped');
    end if;
    update public.broadcast_recipients
       set status = 'skipped', skip_reason = left(coalesce(p_error, 'unreachable'), 60)
     where id = p_recipient_id;
  else
    if v_r.channel = 'sms' and v_r.credits > 0 then
      perform public.sms_credit_move(
        v_r.tenant_id, v_r.credits, 'refund', null,
        'Broadcast send failed');
    end if;

    update public.broadcast_recipients
       set status = 'failed', error = left(coalesce(p_error, 'send_failed'), 300)
     where id = p_recipient_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Did it work?
-- ---------------------------------------------------------------------------
/**
 * Delivery, clicks and revenue for one send.
 *
 * Attribution is deliberately conservative and deliberately explained rather
 * than presented as a single confident number:
 *
 *   **orders** — placed by somebody this broadcast reached, after it was sent,
 *   inside the window. Correlation, and labelled as such in the UI.
 *   **redeemed** — orders that used *this broadcast's voucher code*. Causation,
 *   as close as any of this gets.
 *
 * A seller deciding whether to spend 800 credits again wants both, because the
 * first is bigger and the second is true.
 */
create or replace function public.broadcast_report(
  p_broadcast_id uuid,
  p_window_days  int default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_b     record;
  v_since timestamptz;
  v_until timestamptz;
begin
  select * into v_b from public.broadcasts where id = p_broadcast_id;
  if v_b.id is null then return null; end if;
  if not public.is_tenant_member(v_b.tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_since := coalesce(v_b.started_at, v_b.created_at);
  v_until := v_since + make_interval(days => greatest(coalesce(p_window_days, 7), 1));

  return jsonb_build_object(
    'id', v_b.id,
    'name', v_b.name,
    'status', v_b.status,
    'body', v_b.body,
    'startedAt', v_b.started_at,
    'finishedAt', v_b.finished_at,
    'recipients', v_b.recipient_count,
    'sent', v_b.sent_count,
    'failed', v_b.failed_count,
    'skipped', v_b.skipped_count,
    'credits', v_b.credits_spent,
    'bySms', (select count(*)::int from public.broadcast_recipients
              where broadcast_id = v_b.id and channel = 'sms' and status = 'sent'),
    'byMessenger', (select count(*)::int from public.broadcast_recipients
                    where broadcast_id = v_b.id and channel = 'messenger' and status = 'sent'),
    'clicks', coalesce((select click_count from public.short_links
                        where id = v_b.short_link_id), 0),
    'windowDays', greatest(coalesce(p_window_days, 7), 1),
    'attributed', (
      select jsonb_build_object(
        'orders', count(*)::int,
        'revenue', coalesce(sum(o.grand_total_centavos), 0))
      from public.orders o
      where o.tenant_id = v_b.tenant_id
        and o.fulfillment_status <> 'cancelled'
        and o.placed_at between v_since and v_until
        and o.customer_id in (
          select customer_id from public.broadcast_recipients
          where broadcast_id = v_b.id and status = 'sent')),
    'redeemed', (
      select jsonb_build_object(
        'orders', count(*)::int,
        'revenue', coalesce(sum(o.grand_total_centavos), 0),
        'discount', coalesce(sum(r.amount_centavos), 0))
      from public.discount_redemptions r
        join public.orders o on o.id = r.order_id
      where r.discount_id = v_b.discount_id
        and o.fulfillment_status <> 'cancelled'
        and o.placed_at between v_since and v_until));
end;
$$;

/** The list, with enough on each row to decide which one to open. */
create or replace function public.broadcasts_list(p_tenant_id uuid, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'status', b.status, 'channel', b.channel,
      'body', b.body, 'recipients', b.recipient_count, 'sent', b.sent_count,
      'skipped', b.skipped_count, 'credits', b.credits_spent,
      'scheduledAt', b.scheduled_at, 'startedAt', b.started_at,
      'createdAt', b.created_at,
      'clicks', coalesce((select click_count from public.short_links
                          where id = b.short_link_id), 0))
      order by b.created_at desc)
    from (select * from public.broadcasts where tenant_id = p_tenant_id
          order by created_at desc
          limit greatest(least(coalesce(p_limit, 30), 100), 1)) b), '[]'::jsonb);
end;
$$;

/** Save a draft. Staff, because sending one spends the store's money. */
create or replace function public.broadcast_save(
  p_tenant_id   uuid,
  p_name        text,
  p_body        text,
  p_definition  jsonb,
  p_channel     text default 'auto',
  p_id          uuid default null,
  p_discount_id uuid default null,
  p_scheduled_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  if p_id is null then
    insert into public.broadcasts
      (tenant_id, name, body, segment_definition, channel, discount_id,
       scheduled_at, status, created_by)
    values (p_tenant_id, btrim(p_name), p_body, coalesce(p_definition, '{}'::jsonb),
            p_channel, p_discount_id, p_scheduled_at,
            case when p_scheduled_at is null then 'draft' else 'scheduled' end,
            auth.uid())
    returning id into v_id;
  else
    update public.broadcasts
       set name = btrim(p_name), body = p_body,
           segment_definition = coalesce(p_definition, '{}'::jsonb),
           channel = p_channel, discount_id = p_discount_id,
           scheduled_at = p_scheduled_at,
           status = case when p_scheduled_at is null then 'draft' else 'scheduled' end
     where id = p_id and tenant_id = p_tenant_id and status in ('draft', 'scheduled')
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

/** What a scheduler would pick up, once there is one. */
create or replace function public.broadcasts_due()
returns table (id uuid, tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select id, tenant_id from public.broadcasts
  where status = 'scheduled' and scheduled_at is not null and scheduled_at <= now()
  order by scheduled_at
  limit 50;
$$;

-- ---------------------------------------------------------------------------
-- Checkout, now that a cart can carry a voucher
-- ---------------------------------------------------------------------------
/**
 * Two changes, both about the same rule.
 *
 * The per-customer limit on a voucher can only be checked against a person, and
 * the person's phone number does not exist until this function is called. So the
 * code is re-evaluated here with the phone, and a cart whose code has stopped
 * being valid is **repriced** rather than charged at the quote the buyer was
 * shown. Hard rule 6, in the one place it has always mattered most.
 *
 * And the redemption is recorded from the *final* pricing, so `used_count` —
 * which is a projection of that table — counts orders that exist.
 */
CREATE OR REPLACE FUNCTION public.checkout_place_order(p_token text, p_contact_name text, p_contact_phone text, p_address jsonb, p_payment_method text DEFAULT 'cod'::text, p_contact_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cart        record;
  v_pricing     jsonb;
  v_location_id uuid;
  v_customer_id uuid;
  v_order_id    uuid;
  v_number      text;
  v_items       jsonb;
  v_disc        jsonb;
  v_disc_id     uuid;
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
  -- `grabpay` joins the list: it was in the core PaymentMethod union all along and
  -- the spec asks for it, but the phase-6 CHECK omitted it.
  if p_payment_method is null
     or p_payment_method not in ('cod','gcash','maya','grabpay','card','bank','qrph') then
    raise exception 'Unsupported payment method %', p_payment_method
      using errcode = 'check_violation';
  end if;

  -- Phase 6 refused every method but COD, because an online order would have been
  -- unpayable. Phase 8 made that false, so the blanket refusal becomes a real
  -- check: online is available exactly when this tenant has a working, enabled
  -- payment account. Refusing here rather than at the provider call keeps the
  -- failure cheap — no stock is reserved and no order exists yet.
  if p_payment_method <> 'cod'
     and not public.checkout_online_available(v_cart.tenant_id) then
    raise exception 'This store is not accepting online payments yet'
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

  -- Phase 12: this buyer, at this store, on COD.
  --
  -- The flag is a seller's explicit decision, never the computed RTS score — a
  -- score can be wrong (a buyer who moved house has a bad month) and refusing
  -- someone's money automatically, on a signal they cannot see or appeal, is not
  -- a thing to do quietly. `buyer_risk_flags.block_cod` is set by hand from the
  -- returns screen; the score only surfaces the candidates.
  --
  -- Matched on national digits, because the same buyer types `09171234567` here
  -- and appears as `+639171234567` on the order that burned the seller, and
  -- neither string contains the other.
  if p_payment_method = 'cod' and exists (
    select 1 from public.buyer_risk_flags f
    where f.tenant_id = v_cart.tenant_id
      and f.phone_digits = public.ph_national_digits(p_contact_phone)
      and f.block_cod
  ) then
    raise exception 'This number cannot use cash on delivery at this store'
      using errcode = 'feature_not_supported', hint = 'cod_blocked_buyer';
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

  -- ---- The voucher, re-checked against a person -------------------------
  -- `cart_pricing` evaluated the code without a phone number, because on the
  -- cart page there is not one. The per-customer limit can only be asked here,
  -- so it is asked here — and if the answer has changed, the cart is repriced
  -- rather than charged at the quote the buyer was shown. Hard rule 6.
  if coalesce(btrim(coalesce(v_cart.discount_code, '')), '') <> '' then
    v_disc := public.discount_evaluate(
      v_cart.tenant_id, v_cart.discount_code,
      (v_pricing ->> 'subtotal')::bigint,
      (v_pricing ->> 'shippingBeforeDiscount')::bigint,
      p_contact_phone);

    if coalesce((v_disc ->> 'valid')::boolean, false) is not true then
      update public.carts set discount_code = null where id = v_cart.id;
      v_pricing := public.cart_pricing(
        v_cart.id, p_payment_method,
        p_address ->> 'regionCode', nullif(p_address ->> 'provinceCode', ''),
        p_address ->> 'cityCode');
    end if;
  end if;

  v_disc_id := nullif(v_pricing -> 'discount' ->> 'id', '')::uuid;

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

  -- The redemption row *is* the usage count: `discounts.used_count` is a
  -- projection of this table, so a limit cannot be consumed by an order that
  -- was never placed, and a replayed checkout cannot consume it twice.
  if v_disc_id is not null then
    insert into public.discount_redemptions
      (tenant_id, discount_id, order_id, customer_id, phone, amount_centavos)
    values (v_cart.tenant_id, v_disc_id, v_order_id, v_customer_id, p_contact_phone,
            (v_pricing ->> 'discountTotal')::bigint)
    on conflict (discount_id, order_id) do nothing;
  end if;

  -- The customer's totals used to be incremented here, by hand, from a local
  -- variable. Phase 15 made them a projection of the orders table maintained by
  -- trigger, so by the time control reaches this line the arithmetic has already
  -- been done from the ledger — and doing it again would double every storefront
  -- purchase. The guard on `customers` now raises if anything tries.

  return public.order_receipt(v_order_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Carts that stopped
-- ---------------------------------------------------------------------------
/**
 * A cart with something in it that nobody checked out.
 *
 * The recovery token is the cart's own token, not a new one. That is the whole
 * trick: phase 6 built the cart around an unguessable token in an httpOnly
 * cookie, and `/live/claim/{token}` from phase 13 already adopts a cart into a
 * browser. A recovery link is the same move — the buyer taps it on the phone
 * they read the SMS on, and their cart is simply there.
 *
 * `reminders_sent` rather than a boolean, because the sequence is 1h / 24h /
 * 72h and the thing that must never happen is a buyer getting the 1-hour nudge
 * three times.
 */
create table public.abandoned_carts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  cart_id   uuid not null,

  /** Snapshot at the moment it was noticed, so a report is not a live query. */
  subtotal_centavos public.centavos not null default 0,
  item_count int not null default 0,
  phone text,
  customer_id uuid,

  reminders_sent int not null default 0 check (reminders_sent between 0 and 3),
  last_reminder_at timestamptz,
  /** The voucher the last nudge carried, if the seller let it escalate. */
  discount_id uuid,

  recovered_order_id uuid,
  recovered_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (cart_id),
  foreign key (tenant_id, cart_id)
    references public.carts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null (customer_id)
);

create index abandoned_carts_due_idx
  on public.abandoned_carts (tenant_id, reminders_sent, last_reminder_at)
  where recovered_order_id is null;

create trigger abandoned_carts_touch
  before update on public.abandoned_carts
  for each row execute function public.set_updated_at();

/**
 * Notice the carts that stopped, and say which nudge each is due.
 *
 * A cart is abandoned when it has items, a way to reach the buyer, and an hour
 * of silence. The phone is the constraint that matters: a guest cart with no
 * contact details is not recoverable by any channel, and counting it would give
 * the seller an abandonment rate they can do nothing about.
 *
 * Returns what is *due* rather than sending anything, so the sequence can be
 * driven by the same job runner everything else is waiting for, and so the
 * decision is inspectable in a test.
 */
create or replace function public.abandoned_carts_sweep(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_found int;
begin
  -- 1. Notice them. `carts.customer_id` is set by a live claim or by a returning
  --    buyer; a phone comes from the customer record.
  insert into public.abandoned_carts
    (tenant_id, cart_id, subtotal_centavos, item_count, phone, customer_id)
  select
    c.tenant_id, c.id,
    coalesce((public.cart_pricing(c.id) ->> 'subtotal')::bigint, 0),
    coalesce((public.cart_pricing(c.id) ->> 'itemCount')::int, 0),
    cu.phone, c.customer_id
  from public.carts c
    left join public.customers cu on cu.id = c.customer_id
  where c.status = 'active'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and c.updated_at < now() - interval '1 hour'
    and c.expires_at > now()
    and exists (select 1 from public.cart_items i where i.cart_id = c.id)
    and cu.phone is not null
  on conflict (cart_id) do nothing;

  get diagnostics v_found = row_count;

  -- 2. Close the ones that came back. A cart that converted is not abandoned,
  --    and the order it produced is the recovery.
  update public.abandoned_carts a
     set recovered_order_id = o.id, recovered_at = coalesce(a.recovered_at, now())
  from public.orders o
  where o.cart_id = a.cart_id
    and a.recovered_order_id is null;

  return jsonb_build_object('noticed', v_found);
end;
$$;

/**
 * Which nudge is due, and to whom.
 *
 * 1h / 24h / 72h, measured from the *last* reminder rather than from abandonment,
 * so a sweep that ran late does not fire two nudges in the same minute.
 */
create or replace function public.abandoned_carts_due(p_tenant_id uuid default null)
returns table (
  id uuid,
  tenant_id uuid,
  cart_id uuid,
  phone text,
  customer_id uuid,
  subtotal_centavos bigint,
  step int
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.tenant_id, a.cart_id, a.phone, a.customer_id,
         a.subtotal_centavos::bigint, a.reminders_sent + 1
  from public.abandoned_carts a
    join public.carts c on c.id = a.cart_id
  where a.recovered_order_id is null
    and c.status = 'active'
    and a.reminders_sent < 3
    and (p_tenant_id is null or a.tenant_id = p_tenant_id)
    and case a.reminders_sent
          when 0 then a.created_at <= now()
          when 1 then coalesce(a.last_reminder_at, a.created_at) <= now() - interval '23 hours'
          else        coalesce(a.last_reminder_at, a.created_at) <= now() - interval '48 hours'
        end
  order by a.created_at
  limit 200;
$$;

/** Record a nudge. Separate from deciding, so a failed send is not a nudge. */
create or replace function public.abandoned_cart_record_reminder(
  p_id uuid,
  p_discount_id uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.abandoned_carts
     set reminders_sent = least(reminders_sent + 1, 3),
         last_reminder_at = now(),
         discount_id = coalesce(p_discount_id, discount_id)
   where id = p_id;
$$;

/**
 * What the seller sees.
 *
 * Recovered *revenue* rather than a recovery rate, because the number a seller
 * acts on is "this brought back ₱8,400 last month", and a percentage of carts
 * they never saw is not.
 */
create or replace function public.abandoned_carts_report(
  p_tenant_id uuid,
  p_days      int default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return (
    select jsonb_build_object(
      'abandoned', count(*)::int,
      'value', coalesce(sum(a.subtotal_centavos), 0),
      'reminded', count(*) filter (where a.reminders_sent > 0)::int,
      'recovered', count(*) filter (where a.recovered_order_id is not null)::int,
      'recoveredRevenue', coalesce(sum(o.grand_total_centavos) filter (
        where a.recovered_order_id is not null), 0))
    from public.abandoned_carts a
      left join public.orders o on o.id = a.recovered_order_id
    where a.tenant_id = p_tenant_id
      and a.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1)));
end;
$$;

-- ---------------------------------------------------------------------------
-- The counters are projections, and only the triggers may write them
-- ---------------------------------------------------------------------------
/**
 * `used_count`, `click_count` and the four counters on `broadcasts` are caches
 * of rows that exist elsewhere — redemptions, clicks, recipients. Every one of
 * them is maintained by a trigger above, and every one of them was, until this
 * block, also writable by hand.
 *
 * That is the same defect phase 4 fixed on `inventory_levels.on_hand` and phase
 * 15 fixed on `customers.total_spent_centavos`, and it matters here for the same
 * reason plus one: these numbers are what a seller decides on. "This voucher has
 * been used 43 times" justifies leaving it running; "this send cost 790 credits"
 * is what they reconcile the bill against. A number that two things can write is
 * a number that cannot answer "why".
 *
 * `pg_trigger_depth() > 1` is what lets the maintaining triggers through: they
 * run nested inside the statement that changed the underlying rows, and a seller
 * typing into the table does not.
 */
create or replace function public.discounts_guard_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.used_count is distinct from old.used_count then
    raise exception
      'A voucher''s usage count is a projection of its redemptions and cannot be written directly'
      using errcode = 'check_violation', hint = 'discount_counts_readonly';
  end if;
  return new;
end;
$$;

drop trigger if exists discounts_guard_counts on public.discounts;
create trigger discounts_guard_counts
  before update on public.discounts
  for each row execute function public.discounts_guard_counts();

create or replace function public.short_links_guard_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.click_count is distinct from old.click_count then
    raise exception
      'A link''s click count is a projection of its clicks and cannot be written directly'
      using errcode = 'check_violation', hint = 'short_link_counts_readonly';
  end if;
  return new;
end;
$$;

drop trigger if exists short_links_guard_counts on public.short_links;
create trigger short_links_guard_counts
  before update on public.short_links
  for each row execute function public.short_links_guard_counts();

create or replace function public.broadcasts_guard_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.recipient_count is distinct from old.recipient_count
     or new.sent_count    is distinct from old.sent_count
     or new.skipped_count is distinct from old.skipped_count
     or new.failed_count  is distinct from old.failed_count
     or new.credits_spent is distinct from old.credits_spent then
    raise exception
      'A send''s counts are a projection of its recipients and cannot be written directly'
      using errcode = 'check_violation', hint = 'broadcast_counts_readonly';
  end if;
  return new;
end;
$$;

drop trigger if exists broadcasts_guard_counts on public.broadcasts;
create trigger broadcasts_guard_counts
  before update on public.broadcasts
  for each row execute function public.broadcasts_guard_counts();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.discounts            enable row level security;
alter table public.discounts            force  row level security;
alter table public.discount_redemptions enable row level security;
alter table public.discount_redemptions force  row level security;
alter table public.broadcasts           enable row level security;
alter table public.broadcasts           force  row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.broadcast_recipients force  row level security;
alter table public.short_links          enable row level security;
alter table public.short_links          force  row level security;
alter table public.short_link_clicks    enable row level security;
alter table public.short_link_clicks    force  row level security;
alter table public.abandoned_carts      enable row level security;
alter table public.abandoned_carts      force  row level security;

create policy "Members read discounts" on public.discounts for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write discounts" on public.discounts for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update discounts" on public.discounts for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete discounts" on public.discounts for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

create policy "Members read redemptions" on public.discount_redemptions for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Members read broadcasts" on public.broadcasts for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read broadcast recipients" on public.broadcast_recipients
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Members read abandoned carts" on public.abandoned_carts
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Members read short links" on public.short_links
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- `short_link_clicks` has no policy at all. It is written by a definer when a
-- buyer follows a link and read through `short_links.click_count`; a per-click
-- log with timestamps is a browsing history, and nothing in the product needs
-- to read one row of it.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.discounts to authenticated;
grant select on public.discount_redemptions to authenticated;
grant select on public.broadcasts           to authenticated;
grant select on public.broadcast_recipients to authenticated;
grant select on public.abandoned_carts      to authenticated;
grant select on public.short_links          to authenticated;

grant execute on function public.broadcast_preview(uuid, jsonb, text, text, uuid) to authenticated;
grant execute on function public.broadcast_save(uuid, text, text, jsonb, text, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.broadcast_start(uuid)          to authenticated;
grant execute on function public.broadcast_report(uuid, int)    to authenticated;
grant execute on function public.broadcasts_list(uuid, int)     to authenticated;
grant execute on function public.abandoned_carts_report(uuid, int) to authenticated;
grant execute on function public.sms_segments(text)             to authenticated;

/**
 * `revoke ... from public` first, then grant — the trap, again.
 *
 * `broadcast_start` spends a store's SMS credits. `discount_evaluate` reads a
 * voucher's rules. Neither has any business being callable by `anon`, and a
 * grant to `authenticated` alone leaves them exactly that.
 */
revoke all on function public.broadcast_preview(uuid, jsonb, text, text, uuid) from public;
revoke all on function public.broadcast_save(uuid, text, text, jsonb, text, uuid, uuid, timestamptz) from public;
revoke all on function public.broadcast_start(uuid)          from public;
revoke all on function public.broadcast_report(uuid, int)    from public;
revoke all on function public.broadcasts_list(uuid, int)     from public;
revoke all on function public.abandoned_carts_report(uuid, int) from public;
revoke all on function public.sms_segments(text)             from public;

grant execute on function public.broadcast_preview(uuid, jsonb, text, text, uuid) to authenticated;
grant execute on function public.broadcast_save(uuid, text, text, jsonb, text, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.broadcast_start(uuid)          to authenticated;
grant execute on function public.broadcast_report(uuid, int)    to authenticated;
grant execute on function public.broadcasts_list(uuid, int)     to authenticated;
grant execute on function public.abandoned_carts_report(uuid, int) to authenticated;
grant execute on function public.sms_segments(text)             to authenticated;

/**
 * Server-only. The sending loop claims recipients, takes credits and records
 * what happened; a client that could call these could spend a store's money or
 * mark a message sent that never was.
 *
 * `short_link_follow` is the exception in the other direction: a buyer tapping a
 * link holds no session at all, so it is granted to `anon` — and it returns a
 * target and nothing else.
 */
revoke all on function public.broadcast_claim_next(uuid)                     from public;
revoke all on function public.broadcast_record_send(uuid, text, text, text, text) from public;
revoke all on function public.broadcast_channel_for(uuid, text)              from public;
revoke all on function public.broadcast_render(text, text, text, text)       from public;
revoke all on function public.short_link_create(uuid, text, text, uuid)      from public;
revoke all on function public.short_link_follow(text, uuid)                  from public;
revoke all on function public.abandoned_carts_sweep(uuid)                    from public;
revoke all on function public.abandoned_carts_due(uuid)                      from public;
revoke all on function public.abandoned_cart_record_reminder(uuid, uuid)     from public;
revoke all on function public.broadcasts_due()                               from public;
revoke all on function public.discount_evaluate(uuid, text, bigint, bigint, text) from public;
revoke all on function public.discount_auto_best(uuid, bigint, bigint)       from public;

grant execute on function public.broadcast_claim_next(uuid)                     to service_role;
grant execute on function public.broadcast_record_send(uuid, text, text, text, text) to service_role;
grant execute on function public.short_link_create(uuid, text, text, uuid)      to service_role;
grant execute on function public.short_link_follow(text, uuid)                  to anon, service_role;
grant execute on function public.abandoned_carts_sweep(uuid)                    to service_role;
grant execute on function public.abandoned_carts_due(uuid)                      to service_role;
grant execute on function public.abandoned_cart_record_reminder(uuid, uuid)     to service_role;
grant execute on function public.broadcasts_due()                               to service_role;
-- The buyer's cart page asks whether a code is any good, and the buyer has no
-- session. It answers with an amount and a reason and reads nothing else.
grant execute on function public.discount_evaluate(uuid, text, bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function public.discount_auto_best(uuid, bigint, bigint)       to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The cart's own code
-- ---------------------------------------------------------------------------
/**
 * Apply or clear a voucher, from the buyer's side of the counter.
 *
 * Takes the cart token, not a cart id, for the phase-6 reason: a buyer has no
 * account, and the token in their httpOnly cookie *is* the authorisation. It
 * returns the whole recomputed cart, so the page cannot draw a total that the
 * database did not produce.
 */
create or replace function public.cart_apply_discount(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart record;
  v_eval jsonb;
begin
  select * into v_cart from public.carts
   where token = p_token and status = 'active' and expires_at > now();
  if v_cart.id is null then
    raise exception 'Cart not found' using errcode = 'no_data_found';
  end if;

  if coalesce(btrim(coalesce(p_code, '')), '') = '' then
    update public.carts set discount_code = null where id = v_cart.id;
    return jsonb_build_object('outcome', 'cleared', 'cart', public.cart_view(p_token));
  end if;

  v_eval := public.discount_evaluate(
    v_cart.tenant_id, p_code,
    coalesce((public.cart_pricing(v_cart.id) ->> 'subtotal')::bigint, 0),
    coalesce((public.cart_pricing(v_cart.id) ->> 'shippingBeforeDiscount')::bigint, 0),
    null);

  if coalesce((v_eval ->> 'valid')::boolean, false) is not true then
    -- The reason travels with the refusal. "Add ₱200 more to use this" is a
    -- sentence that sells something; "invalid code" is one that ends a session.
    return jsonb_build_object('outcome', 'rejected', 'reason', v_eval ->> 'reason',
                              'detail', v_eval);
  end if;

  update public.carts set discount_code = upper(btrim(p_code)) where id = v_cart.id;

  return jsonb_build_object('outcome', 'applied', 'discount', v_eval,
                            'cart', public.cart_view(p_token));
end;
$$;

revoke all on function public.cart_apply_discount(text, text) from public;
grant execute on function public.cart_apply_discount(text, text) to anon, authenticated, service_role;
