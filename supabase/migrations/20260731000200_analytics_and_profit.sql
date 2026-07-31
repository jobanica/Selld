/**
 * Phase 18 — Analytics & true profit.
 *
 * The done-when is a sentence a seller says out loud: *"kumita ba ako this
 * month, at magkano talaga"* — did I make money, and how much really. The word
 * doing the work is **talaga**. Every marketplace dashboard already answers
 * "magkano ang benta"; none of them subtracts what the selling cost, and a
 * seller who reads gross sales as income is a seller who reorders stock they
 * cannot afford.
 *
 * ## The one rule everything else follows from: never overstate profit
 *
 * There are two ways to be wrong here and they are not symmetric. Understating
 * profit makes a seller cautious. Overstating it makes them spend money they do
 * not have — and it is the *easy* mistake, because every missing cost silently
 * improves the number. So:
 *
 *   - a cost we do not know is **reported as unknown**, never as zero;
 *   - `coverage` says what fraction of revenue has complete cost data, so the
 *     seller can see how much to trust the figure;
 *   - revenue is money that **arrived**, not money that was promised.
 *
 * ## What counts as revenue
 *
 * Delivered, or paid. The same rule phase 15 chose for lifetime value, and it
 * has to be the same or two screens in one product disagree about the same
 * order. A COD parcel in a van is not revenue; an RTS parcel never was.
 *
 * The RTS case is the one worth stating, because it is where sellers lose money
 * without seeing it: a returned parcel earns nothing **and** costs the outbound
 * *and* the return leg. It appears in this schema as pure cost, which is what it
 * is.
 *
 * ## Recorded costs and estimated ones
 *
 * COGS, shipping, COD fees, payment fees and marketplace commission all come
 * from rows somebody wrote — an order item's cost snapshot, a shipment's
 * `cost_centavos`, a payment's `fee_centavos`. Ad spend and the Selld
 * subscription are the two a seller types in, because nothing in the system
 * knows them. They are kept separate in the response for exactly that reason.
 */

-- ---------------------------------------------------------------------------
-- What a marketplace order actually cost
-- ---------------------------------------------------------------------------
/**
 * Phase 17 pulled `platformFees` off every marketplace order and threw it away.
 *
 * That was fine for a phase about stock and wrong for one about profit: a Shopee
 * order at PHP 500 with PHP 30 of commission is PHP 470 of revenue, and counting
 * the 500 overstates profit by exactly the amount the marketplace took. It is
 * also the honest half of the commission-kept counter — a seller has not "saved"
 * commission on the orders they took *through* a marketplace.
 */
alter table public.orders
  add column if not exists platform_fee_centavos public.centavos not null default 0;

comment on column public.orders.platform_fee_centavos is
  'What a marketplace deducted from this order. Zero for orders Selld took directly.';

-- ---------------------------------------------------------------------------
-- Ad spend
-- ---------------------------------------------------------------------------
/**
 * The one cost nothing in Selld can observe.
 *
 * Typed in by the seller, per day and per channel, because "how much did you
 * spend on ads this month" is a question they can answer and a boosted post is
 * not something we can see. Per *day* rather than per month so a month boundary
 * does not have to be guessed at, and so the same table can answer "what did
 * last week cost" later.
 *
 * `spent_on` is a date, not a timestamptz: ad platforms report on their own
 * calendar day and a seller types what Facebook told them. Storing an instant
 * would invite a timezone conversion nobody asked for.
 */
create table public.ad_spend (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  spent_on  date not null,
  channel   text not null default 'facebook'
    check (channel in ('facebook', 'instagram', 'tiktok', 'google', 'shopee', 'lazada', 'other')),
  amount_centavos public.centavos not null check (amount_centavos >= 0),
  note      text,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  -- One row per day per channel. A seller correcting yesterday's figure is
  -- editing it, not adding a second one — and two rows for one day is how ad
  -- spend gets double-counted and profit understated.
  unique (tenant_id, spent_on, channel)
);

create index ad_spend_tenant_idx on public.ad_spend (tenant_id, spent_on desc);

create trigger ad_spend_set_updated_at
  before update on public.ad_spend
  for each row execute function public.set_updated_at();

/** Type in a day's spend, or correct it. */
create or replace function public.ad_spend_record(
  p_tenant_id uuid,
  p_spent_on  date,
  p_amount    bigint,
  p_channel   text default 'facebook',
  p_note      text default null
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

  insert into public.ad_spend (tenant_id, spent_on, channel, amount_centavos, note, created_by)
  values (p_tenant_id, p_spent_on, coalesce(p_channel, 'facebook'), greatest(p_amount, 0),
          p_note, auth.uid())
  on conflict (tenant_id, spent_on, channel) do update
    set amount_centavos = excluded.amount_centavos,
        note = coalesce(excluded.note, public.ad_spend.note)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The answer
-- ---------------------------------------------------------------------------
/**
 * Did I make money, and how much really.
 *
 * One function, one round trip, because the seller is asking one question. The
 * response is deliberately shaped as *revenue, then every subtraction in order,
 * then the number* — a profit figure with no visible arithmetic behind it is a
 * figure nobody believes the first time it is bad news.
 *
 * ## Why every cost is a separate scan
 *
 * Joining shipments, payments and order items onto orders in one query
 * multiplies rows: an order with three items and two payments would count its
 * shipping cost six times. Each cost is therefore aggregated against the order
 * set independently and subtracted once. Slower, and correct, and the kind of
 * thing that is invisible until a seller's profit is wrong by exactly the
 * number of items in their biggest order.
 *
 * ## Manila days
 *
 * Hard rule 3. "This month" is a Manila month, so an order placed at 07:30 on
 * the first is in it and one placed at 07:30 UTC on the last day of the previous
 * month is not.
 */
create or replace function public.analytics_profit(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to   date;
  v_result jsonb;

  v_revenue       bigint := 0;
  v_orders        int    := 0;
  v_units         int    := 0;
  v_cogs          bigint := 0;
  v_cogs_known    bigint := 0;
  v_line_total    bigint := 0;
  v_cogs_missing  int    := 0;
  v_shipping      bigint := 0;
  v_ship_missing  int    := 0;
  v_cod_fees      bigint := 0;
  v_pay_fees      bigint := 0;
  v_platform      bigint := 0;
  v_rts_cost      bigint := 0;
  v_rts_orders    int    := 0;
  v_ads           bigint := 0;
  v_subscription  bigint := 0;
  v_in_flight     bigint := 0;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- Default window: this Manila month, from the first to today.
  v_to   := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);

  -- ---- Revenue: money that arrived --------------------------------------
  select
    coalesce(sum(o.grand_total_centavos::bigint), 0),
    count(*)::int,
    coalesce(sum(o.cod_fee_centavos::bigint), 0),
    coalesce(sum(o.platform_fee_centavos::bigint), 0)
  into v_revenue, v_orders, v_cod_fees, v_platform
  from public.orders o
  where o.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and (o.fulfillment_status = 'delivered' or o.payment_status = 'paid')
    and o.fulfillment_status <> 'cancelled';

  -- COD that has shipped and not yet arrived. Not revenue, and not nothing —
  -- a seller looking at a thin month needs to know how much is still in a van.
  select coalesce(sum(o.grand_total_centavos::bigint), 0)
  into v_in_flight
  from public.orders o
  where o.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and o.payment_status <> 'paid'
    and o.fulfillment_status in ('confirmed', 'packed', 'shipped');

  -- ---- COGS -------------------------------------------------------------
  -- `cost_centavos` is a snapshot taken at checkout, so it is what the stock
  -- cost *then* rather than what a re-order costs now. That is the right number
  -- for a margin and the wrong one for a purchase decision; the screen says so.
  select
    coalesce(sum(oi.cost_centavos::bigint * oi.qty) filter (where oi.cost_centavos is not null), 0),
    coalesce(sum(oi.qty), 0)::int,
    count(*) filter (where oi.cost_centavos is null)::int
  into v_cogs, v_units, v_cogs_missing
  from public.order_items oi
    join public.orders o on o.id = oi.order_id
  where o.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and (o.fulfillment_status = 'delivered' or o.payment_status = 'paid')
    and o.fulfillment_status <> 'cancelled';

  -- What the known-cost lines were worth, so `coverage` is a fraction of value
  -- rather than of rows — one PHP 5,000 line with no cost matters more than
  -- twenty PHP 50 lines that have one.
  --
  -- Measured against *item* revenue, not against `grand_total`. Grand total
  -- carries shipping and the COD fee, which no line item ever accounts for, so
  -- a store with complete cost data would still have read 0.97 and looked
  -- permanently short of something.
  select
    coalesce(sum(oi.line_total_centavos::bigint) filter (where oi.cost_centavos is not null), 0),
    coalesce(sum(oi.line_total_centavos::bigint), 0)
  into v_cogs_known, v_line_total
  from public.order_items oi
    join public.orders o on o.id = oi.order_id
  where o.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and (o.fulfillment_status = 'delivered' or o.payment_status = 'paid')
    and o.fulfillment_status <> 'cancelled';

  -- ---- Shipping actually paid to the courier ----------------------------
  select
    coalesce(sum(s.cost_centavos::bigint), 0),
    count(*) filter (where s.cost_centavos is null)::int
  into v_shipping, v_ship_missing
  from public.shipments s
    join public.orders o on o.id = s.order_id
  where s.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and o.fulfillment_status <> 'cancelled';

  -- ---- Payment processor fees -------------------------------------------
  select coalesce(sum(p.fee_centavos::bigint), 0)
  into v_pay_fees
  from public.payments p
    join public.orders o on o.id = p.order_id
  where p.tenant_id = p_tenant_id
    and p.status = 'paid'
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to;

  -- ---- Returns: the cost with no revenue behind it ----------------------
  -- Both legs. A seller who has been told "RTS rate 8%" and not "RTS cost you
  -- PHP 4,200 this month" has been told a statistic instead of a number.
  select
    coalesce(sum(r.outbound_cost_centavos::bigint + r.return_cost_centavos::bigint), 0),
    count(*)::int
  into v_rts_cost, v_rts_orders
  from public.order_rts r
    join public.orders o on o.id = r.order_id
  where r.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to;

  -- ---- The two the seller types in --------------------------------------
  select coalesce(sum(a.amount_centavos::bigint), 0)
  into v_ads
  from public.ad_spend a
  where a.tenant_id = p_tenant_id and a.spent_on between v_from and v_to;

  -- Pro-rated across the window by days, so a fortnight does not carry a whole
  -- month's subscription.
  v_subscription := (
    coalesce((select (value #>> '{}')::bigint from public.tenant_settings
              where tenant_id = p_tenant_id and key = 'analytics.subscription_centavos'), 0)
    * (v_to - v_from + 1)
    / greatest(extract(day from (date_trunc('month', v_to) + interval '1 month - 1 day'))::int, 1)
  )::bigint;

  v_result := jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'revenue', v_revenue,
    'orders', v_orders,
    'units', v_units,
    'aov', case when v_orders = 0 then 0 else (v_revenue / v_orders)::bigint end,
    'inFlight', v_in_flight,

    'costs', jsonb_build_object(
      'cogs', v_cogs,
      'shipping', v_shipping,
      'codFees', v_cod_fees,
      'paymentFees', v_pay_fees,
      'platformFees', v_platform,
      'returns', v_rts_cost,
      'ads', v_ads,
      'subscription', v_subscription),

    'profit', v_revenue - v_cogs - v_shipping - v_cod_fees - v_pay_fees
              - v_platform - v_rts_cost - v_ads - v_subscription,
    'grossMargin', v_revenue - v_cogs,

    'returns', jsonb_build_object('orders', v_rts_orders, 'cost', v_rts_cost),

    -- How much of this to believe. A cost we do not know is reported, never
    -- assumed to be zero — a missing cost silently *improves* profit, which is
    -- the one direction it must never be wrong in.
    'coverage', jsonb_build_object(
      'costedRevenue', v_cogs_known,
      'itemRevenue', v_line_total,
      'costedFraction', case when v_line_total = 0 then 1::numeric
                             else round(v_cogs_known::numeric / v_line_total, 4) end,
      'itemsWithoutCost', v_cogs_missing,
      'shipmentsWithoutCost', v_ship_missing));

  return v_result;
end;
$$;

/**
 * What a marketplace would have taken on the same sales.
 *
 * The retention number, and it has to be honest or it is worse than nothing.
 * Two things make it honest:
 *
 *   - orders that *came from* a marketplace are excluded. A seller did not save
 *     commission on a Shopee sale; they paid it, and it is in `platform_fee_centavos`.
 *   - the rate is a setting, defaulting to 550 bps — roughly what Shopee and
 *     Lazada charge a PH non-mall seller once commission and payment fees are
 *     added together. A seller on a different plan can correct it.
 */
create or replace function public.analytics_commission_kept(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to   date;
  v_direct bigint := 0;
  v_paid   bigint := 0;
  v_bps    int;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_to   := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);

  v_bps := coalesce((select (value #>> '{}')::int from public.tenant_settings
                     where tenant_id = p_tenant_id
                       and key = 'analytics.marketplace_commission_bps'), 550);

  select
    coalesce(sum(o.grand_total_centavos::bigint) filter (where o.source <> 'marketplace'), 0),
    coalesce(sum(o.platform_fee_centavos::bigint), 0)
  into v_direct, v_paid
  from public.orders o
  where o.tenant_id = p_tenant_id
    and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
    and (o.fulfillment_status = 'delivered' or o.payment_status = 'paid')
    and o.fulfillment_status <> 'cancelled';

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'bps', v_bps,
    'directRevenue', v_direct,
    'kept', (v_direct * v_bps / 10000)::bigint,
    -- Shown beside it, because a counter that only ever goes up is an
    -- advertisement. What a marketplace actually took this month is the
    -- comparison that makes the saving mean something.
    'paidToMarketplaces', v_paid);
end;
$$;

/**
 * Where the money came from, and which products are worth selling.
 *
 * "Best products" ranked by **margin**, not revenue, which is the whole point of
 * the section: the item a seller sells most of is very often the one they make
 * least on, and no marketplace dashboard will ever tell them that.
 */
create or replace function public.analytics_breakdown(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null,
  p_limit     int default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to   date;
  v_limit int := greatest(least(coalesce(p_limit, 10), 100), 1);
  v_result jsonb;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_to   := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);

  with counted as (
    select o.*
    from public.orders o
    where o.tenant_id = p_tenant_id
      and (o.placed_at at time zone 'Asia/Manila')::date between v_from and v_to
      and (o.fulfillment_status = 'delivered' or o.payment_status = 'paid')
      and o.fulfillment_status <> 'cancelled'
  )
  select jsonb_build_object(
    'byChannel', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', c.source,
        'orders', c.orders,
        'revenue', c.revenue,
        'aov', case when c.orders = 0 then 0 else (c.revenue / c.orders)::bigint end)
        order by c.revenue desc)
      from (
        select source, count(*)::int as orders,
               sum(grand_total_centavos::bigint) as revenue
        from counted group by source) c), '[]'::jsonb),

    'byCity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city', t.city, 'orders', t.orders, 'revenue', t.revenue)
        order by t.revenue desc)
      from (
        select
          coalesce(
            (select ct.display_name from public.psgc_cities ct
             where ct.code = counted.shipping_address ->> 'cityCode'),
            'Unknown') as city,
          count(*)::int as orders,
          sum(grand_total_centavos::bigint) as revenue
        from counted
        group by 1
        order by revenue desc
        limit v_limit) t), '[]'::jsonb),

    -- Ranked by margin, and **only products whose cost is known**.
    --
    -- A product with no cost recorded computes a margin equal to its whole sale
    -- price, which puts it straight to the top of a list headed "best products"
    -- — the most profitable thing in the store turns out to be the one thing
    -- nobody has costed. That is the overstatement rule again, wearing a
    -- ranking: the uncosted ones come back under `uncosted` instead, where they
    -- read as work to do rather than as a success.
    'byProduct', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productName', p.name,
        'sku', p.sku,
        'units', p.units,
        'revenue', p.revenue,
        'cost', p.cost,
        'margin', p.revenue - p.cost,
        'marginPct', case when p.revenue = 0 then 0
                          else round((p.revenue - p.cost)::numeric / p.revenue * 100, 1) end,
        'costKnown', p.cost_known)
        order by (p.revenue - p.cost) desc)
      from (
        select
          oi.product_name as name,
          max(oi.sku) as sku,
          sum(oi.qty)::int as units,
          sum(oi.line_total_centavos::bigint) as revenue,
          coalesce(sum(oi.cost_centavos::bigint * oi.qty), 0) as cost,
          bool_and(oi.cost_centavos is not null) as cost_known
        from public.order_items oi
          join counted on counted.id = oi.order_id
        group by oi.product_name
        having bool_and(oi.cost_centavos is not null)
        order by (sum(oi.line_total_centavos::bigint)
                  - coalesce(sum(oi.cost_centavos::bigint * oi.qty), 0)) desc
        limit v_limit) p), '[]'::jsonb),

    -- Sold, but with no cost behind it. Named, because "we cannot tell you what
    -- this earned" is useful and "this earned its whole sale price" is a lie.
    'uncosted', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productName', u.name, 'units', u.units, 'revenue', u.revenue)
        order by u.revenue desc)
      from (
        select oi.product_name as name,
               sum(oi.qty)::int as units,
               sum(oi.line_total_centavos::bigint) as revenue
        from public.order_items oi
          join counted on counted.id = oi.order_id
        group by oi.product_name
        having bool_or(oi.cost_centavos is null)
        order by sum(oi.line_total_centavos::bigint) desc
        limit v_limit) u), '[]'::jsonb),

    -- The thinnest margin is the worst **rate**, not the smallest total.
    --
    -- Ranking by total picks whatever sold least, which is usually a new line or
    -- a slow week — and on a real fixture it named the store's *best* product,
    -- a 60%-margin serum, simply because six of them earn less in total than
    -- twenty bags at 8%. The seller's question is "which of these is barely
    -- worth selling", and that is a rate.
    --
    -- Floored at 5% of the month's item revenue so a single incidental sale
    -- cannot win a competition about what to stop stocking.
    'worstProduct', (
      select jsonb_build_object(
        'productName', w.name,
        'units', w.units,
        'revenue', w.revenue,
        'margin', w.margin,
        'marginPct', round(w.margin::numeric / w.revenue * 100, 1))
      from (
        select
          oi.product_name as name,
          sum(oi.qty)::int as units,
          sum(oi.line_total_centavos::bigint) as revenue,
          sum(oi.line_total_centavos::bigint)
            - coalesce(sum(oi.cost_centavos::bigint * oi.qty), 0) as margin
        from public.order_items oi
          join counted on counted.id = oi.order_id
        group by oi.product_name
        having bool_and(oi.cost_centavos is not null)
           and sum(oi.line_total_centavos::bigint) > 0
      ) w
      where w.revenue >= (
        select coalesce(sum(oi2.line_total_centavos::bigint), 0) / 20
        from public.order_items oi2 join counted c2 on c2.id = oi2.order_id)
      order by w.margin::numeric / w.revenue asc
      limit 1))
  into v_result;

  return v_result;
end;
$$;

/**
 * Month by month: revenue, profit, RTS rate, repeat rate.
 *
 * A single month's RTS rate is noise — twelve orders and one return reads as 8%
 * and means nothing. A trend is what a seller can act on, which is why this is
 * the only place RTS is expressed as a percentage at all.
 *
 * Repeat rate is computed per *cohort month*: of the customers whose first order
 * was in that month, how many have ordered again since. That is the question
 * worth asking — "what fraction of this month's orders were repeats" moves when
 * acquisition moves, and tells a seller nothing about whether people come back.
 */
create or replace function public.analytics_trends(
  p_tenant_id uuid,
  p_months    int default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_months int := greatest(least(coalesce(p_months, 6), 24), 1);
  v_start  date;
  v_result jsonb;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_start := (date_trunc('month', (now() at time zone 'Asia/Manila')::date)
              - make_interval(months => v_months - 1))::date;

  with months as (
    select generate_series(v_start,
                           date_trunc('month', (now() at time zone 'Asia/Manila')::date)::date,
                           interval '1 month')::date as month
  ),
  scoped as (
    select o.*, date_trunc('month', (o.placed_at at time zone 'Asia/Manila'))::date as month
    from public.orders o
    where o.tenant_id = p_tenant_id
      and (o.placed_at at time zone 'Asia/Manila')::date >= v_start
  ),
  -- A parcel's fate is only known once it has one. Counting an RTS rate over
  -- orders still in a van makes this month always look better than last.
  concluded as (
    select month,
           count(*) filter (where fulfillment_status in ('delivered', 'rts'))::int as decided,
           count(*) filter (where fulfillment_status = 'rts')::int as rts,
           coalesce(sum(grand_total_centavos::bigint)
                    filter (where fulfillment_status = 'delivered'
                               or payment_status = 'paid'), 0) as revenue,
           count(*) filter (where fulfillment_status = 'delivered'
                               or payment_status = 'paid')::int as orders
    from scoped group by month
  ),
  first_orders as (
    select o.customer_id,
           date_trunc('month', min(o.placed_at at time zone 'Asia/Manila'))::date as cohort,
           count(*)::int as lifetime_orders
    from public.orders o
    where o.tenant_id = p_tenant_id
      and o.customer_id is not null
      and o.fulfillment_status <> 'cancelled'
    group by o.customer_id
  )
  select jsonb_agg(jsonb_build_object(
    'month', m.month,
    'revenue', coalesce(c.revenue, 0),
    'orders', coalesce(c.orders, 0),
    'rtsRate', case when coalesce(c.decided, 0) = 0 then null
                    else round(c.rts::numeric / c.decided * 100, 1) end,
    'rtsOrders', coalesce(c.rts, 0),
    'decidedOrders', coalesce(c.decided, 0),
    'cohortSize', coalesce(f.cohort_size, 0),
    'cohortRepeatRate', case when coalesce(f.cohort_size, 0) = 0 then null
                             else round(f.repeaters::numeric / f.cohort_size * 100, 1) end)
    order by m.month)
  into v_result
  from months m
    left join concluded c on c.month = m.month
    left join lateral (
      select count(*)::int as cohort_size,
             count(*) filter (where lifetime_orders > 1)::int as repeaters
      from first_orders where cohort = m.month) f on true;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

/** What a seller has typed in, so they can correct it. */
create or replace function public.ad_spend_list(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to   date;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_to   := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'spentOn', a.spent_on, 'channel', a.channel,
      'amount', a.amount_centavos, 'note', a.note)
      order by a.spent_on desc, a.channel)
    from public.ad_spend a
    where a.tenant_id = p_tenant_id and a.spent_on between v_from and v_to), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- The commission a marketplace took, kept rather than discarded
-- ---------------------------------------------------------------------------
/**
 * `marketplace_order_ingest`, re-created to store `platformFees`.
 *
 * Phase 17 pulled the figure off every Shopee and Lazada order and dropped it,
 * which was fine for a phase about stock. For a phase about profit it is the
 * difference between a PHP 500 order being PHP 500 of revenue and PHP 470 —
 * and, because the commission-kept counter has to exclude what a marketplace
 * *actually* took, it is what stops that counter being an advertisement.
 *
 * Re-created here rather than edited in place: `20260731000100` is pushed, and
 * migrations are append-only after that.
 */
create or replace function public.marketplace_order_ingest(
  p_connection_id uuid,
  p_order         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c        record;
  v_ref      text := p_order ->> 'externalOrderId';
  v_existing uuid;
  v_order    uuid;
  v_customer uuid;
  v_phone    text;
  v_location uuid;
  v_item     jsonb;
  v_variant  uuid;
  v_subtotal bigint := 0;
  v_total    bigint;
  v_unmapped int := 0;
  v_qty      int;
  v_price    bigint;
begin
  select * into v_c from public.marketplace_connections where id = p_connection_id;
  if v_c.id is null then
    raise exception 'Connection not found' using errcode = 'no_data_found';
  end if;
  if v_ref is null or v_ref = '' then
    raise exception 'A marketplace order needs its own id' using errcode = 'check_violation';
  end if;

  select id into v_existing from public.orders
   where tenant_id = v_c.tenant_id and channel_ref = v_ref;
  if v_existing is not null then
    return jsonb_build_object('orderId', v_existing, 'created', false);
  end if;

  v_phone := public.ph_phone_e164(p_order #>> '{shippingAddress,phone}');
  if v_phone is null then
    v_phone := public.ph_phone_e164(p_order ->> 'buyerPhone');
  end if;

  -- A marketplace buyer is a customer like any other, so the CRM, segments and
  -- broadcasts see them. Matched on phone, which is the identity phase 15 chose.
  if v_phone is not null then
    insert into public.customers (tenant_id, name, phone, source)
    values (v_c.tenant_id,
            coalesce(nullif(p_order #>> '{shippingAddress,recipient}', ''),
                     nullif(p_order ->> 'buyerName', ''), 'Marketplace buyer'),
            v_phone, 'marketplace')
    on conflict (tenant_id, phone) do update set name = public.customers.name
    returning id into v_customer;
  end if;

  select id into v_location from public.locations
   where tenant_id = v_c.tenant_id order by is_default desc, created_at limit 1;

  for v_item in select * from jsonb_array_elements(coalesce(p_order -> 'items', '[]'::jsonb))
  loop
    v_qty   := greatest(coalesce((v_item ->> 'qty')::int, 0), 0);
    v_price := coalesce((v_item ->> 'unitPrice')::bigint, 0);
    v_subtotal := v_subtotal + v_qty * v_price;
  end loop;

  v_total := coalesce((p_order ->> 'grandTotal')::bigint, v_subtotal);

  insert into public.orders
    (tenant_id, order_number, customer_id, shipping_address,
     contact_name, contact_phone, contact_email,
     subtotal_centavos, discount_total_centavos, shipping_total_centavos,
     cod_fee_centavos, grand_total_centavos, platform_fee_centavos,
     payment_method, payment_status, fulfillment_status,
     source, channel_ref, placed_at, notes)
  values (
    v_c.tenant_id, public.next_order_number(v_c.tenant_id), v_customer,
    coalesce(p_order -> 'shippingAddress', '{}'::jsonb),
    coalesce(nullif(p_order #>> '{shippingAddress,recipient}', ''),
             nullif(p_order ->> 'buyerName', ''), 'Marketplace buyer'),
    coalesce(v_phone, ''),
    nullif(p_order ->> 'buyerEmail', ''),
    v_subtotal, 0, greatest(v_total - v_subtotal, 0), 0, greatest(v_total, v_subtotal),
    greatest(coalesce((p_order ->> 'platformFees')::bigint, 0), 0),
    case when coalesce((p_order ->> 'isCod')::boolean, false) then 'cod' else 'bank' end,
    case when coalesce((p_order ->> 'isCod')::boolean, false) then 'unpaid' else 'paid' end,
    'confirmed',
    'marketplace', v_ref,
    coalesce((p_order ->> 'placedAt')::timestamptz, now()),
    v_c.platform || ' order ' || v_ref)
  on conflict (tenant_id, channel_ref) where channel_ref is not null do nothing
  returning id into v_order;

  -- Lost the race: another worker inserted this order between the check above
  -- and here. Theirs is as good as ours, and there must only be one parcel.
  if v_order is null then
    select id into v_existing from public.orders
     where tenant_id = v_c.tenant_id and channel_ref = v_ref;
    return jsonb_build_object('orderId', v_existing, 'created', false);
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_order -> 'items', '[]'::jsonb))
  loop
    v_qty   := greatest(coalesce((v_item ->> 'qty')::int, 0), 0);
    v_price := coalesce((v_item ->> 'unitPrice')::bigint, 0);

    select l.variant_id into v_variant
    from public.marketplace_listings l
    where l.connection_id = p_connection_id
      and l.external_item_id = (v_item ->> 'externalItemId')
      and l.external_variation_id is not distinct from
          nullif(v_item ->> 'externalVariationId', '');

    -- Fall back to the SKU: a marketplace can change an item id under a listing,
    -- and the SKU is the identifier the seller controls.
    if v_variant is null and nullif(v_item ->> 'externalSku', '') is not null then
      select v.id into v_variant from public.product_variants v
      where v.tenant_id = v_c.tenant_id
        and upper(btrim(v.sku)) = upper(btrim(v_item ->> 'externalSku'));
    end if;

    insert into public.order_items
      (tenant_id, order_id, variant_id, product_name, variant_label, sku, qty,
       unit_price_centavos, line_total_centavos)
    values (v_c.tenant_id, v_order, v_variant,
            coalesce(v_item ->> 'name', 'Marketplace item'),
            nullif(v_item ->> 'variantLabel', ''),
            nullif(v_item ->> 'externalSku', ''),
            v_qty, v_price, v_qty * v_price);

    if v_variant is null then
      v_unmapped := v_unmapped + 1;
      insert into public.marketplace_issues
        (tenant_id, connection_id, kind, reference, message, detail)
      values (v_c.tenant_id, v_c.id, 'unmapped_sku',
              coalesce(nullif(v_item ->> 'externalSku', ''), v_item ->> 'externalItemId'),
              'An order arrived for an item that is not linked to a product, so its stock was not deducted.',
              jsonb_build_object('orderRef', v_ref, 'name', v_item ->> 'name',
                                 'sku', v_item ->> 'externalSku'))
      on conflict (tenant_id, kind, reference) where resolved_at is null do update
        set detail = excluded.detail, updated_at = now();
    elsif v_location is not null and v_qty > 0 then
      -- The unit is already gone. Follow it, so every *other* channel is told.
      insert into public.stock_movements
        (tenant_id, variant_id, location_id, delta, reason, reference_type, reference_id, note)
      values (v_c.tenant_id, v_variant, v_location, -v_qty, 'sale', 'order', v_order,
              v_c.platform || ' ' || v_ref);
    end if;
  end loop;

  insert into public.marketplace_sync_logs
    (tenant_id, connection_id, direction, entity, status, reference, payload, error)
  values (v_c.tenant_id, v_c.id, 'in', 'order',
          case when v_unmapped > 0 then 'skipped' else 'ok' end,
          v_ref, jsonb_build_object('orderId', v_order, 'unmapped', v_unmapped),
          case when v_unmapped > 0 then v_unmapped || ' item(s) not linked to a product' end);

  update public.marketplace_connections
     set last_order_pull_at = now() where id = v_c.id;

  return jsonb_build_object('orderId', v_order, 'created', true, 'unmapped', v_unmapped);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.ad_spend enable row level security;
alter table public.ad_spend force  row level security;

create policy "Members read ad spend" on public.ad_spend
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Staff write ad spend" on public.ad_spend
  for insert to authenticated with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update ad spend" on public.ad_spend
  for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete ad spend" on public.ad_spend
  for delete to authenticated using (public.has_tenant_role(tenant_id, 'staff'));

grant select, insert, update, delete on public.ad_spend to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
/**
 * `revoke ... from public` first, then grant.
 *
 * These read a store's cost prices and its profit — the two things a competitor
 * would most like and the storefront most deliberately hides. `products_public`
 * exists precisely to keep `cost_centavos` away from a buyer, and it would be a
 * poor joke to expose the same number through an analytics function granted to
 * PUBLIC by default.
 */
revoke all on function public.analytics_profit(uuid, date, date)            from public;
revoke all on function public.analytics_commission_kept(uuid, date, date)   from public;
revoke all on function public.analytics_breakdown(uuid, date, date, int)    from public;
revoke all on function public.analytics_trends(uuid, int)                   from public;
revoke all on function public.ad_spend_record(uuid, date, bigint, text, text) from public;
revoke all on function public.ad_spend_list(uuid, date, date)               from public;

grant execute on function public.analytics_profit(uuid, date, date)            to authenticated;
grant execute on function public.analytics_commission_kept(uuid, date, date)   to authenticated;
grant execute on function public.analytics_breakdown(uuid, date, date, int)    to authenticated;
grant execute on function public.analytics_trends(uuid, int)                   to authenticated;
grant execute on function public.ad_spend_record(uuid, date, bigint, text, text) to authenticated;
grant execute on function public.ad_spend_list(uuid, date, date)               to authenticated;
