-- ===========================================================================
-- Phase 15 — Customers & CRM
-- ===========================================================================
--
-- Every phase so far has been about the *order*. This one is about the person
-- who placed it — because the cheapest sale a Filipino social seller ever makes
-- is the second one to somebody who already trusts them, and until now nothing
-- in Selld could answer "who bought skincare from me, spent real money, and has
-- gone quiet".
--
-- **Done when:** "customers who bought skincare, spent over ₱2,000, haven't
-- ordered in 60 days, zero RTS" is a saved segment.
--
-- ## The shape of it
--
-- `customer_addresses`        saved addresses, so a repeat buyer types nothing
-- `customer_tags` + links     the seller's own words for their own people
-- `customer_segments`         a saved question, answered live
--
-- ## The number that has to be true
--
-- `customers.total_spent_centavos` and `total_orders` already existed, and they
-- were maintained by hand: `checkout_place_order` incremented them as it wrote
-- the order. That is the same mistake `inventory_levels.on_hand` was rescued
-- from in phase 4 — a cache with more than one writer and no way to check it —
-- and it was already wrong in three specific ways:
--
--   * a **cancelled** order still counted, forever
--   * an **RTS** parcel counted as money that arrived, when it is money that
--     came back with a courier fee attached
--   * anything that wrote an order by another route counted not at all
--
-- A segment that says "spent over ₱2,000" is only worth building on a number
-- that is true, so these become a **projection of the orders table**, recomputed
-- by trigger, with a guard that rejects a direct write. `sum(orders) = customer`
-- is then an invariant the tests can assert rather than a hope.

-- ---------------------------------------------------------------------------
-- What a customer's numbers mean
-- ---------------------------------------------------------------------------
/**
 * Five counters and two dates, and the distinction between them is the whole
 * point.
 *
 * `total_spent_centavos` is money that **arrived**: delivered, or paid for.
 * `pending_spent_centavos` is money that has been promised — placed, packed, in
 * a van. A seller reading a customer's lifetime value wants the first; a seller
 * deciding whether to chase a repeat order wants to see both, which is why the
 * profile shows "₱2,400 delivered · ₱800 on the way" rather than one blended
 * figure that is neither.
 *
 * RTS is counted separately rather than netted off, because "spent ₱5,000 and
 * refused two parcels" is a different customer from "spent ₱5,000", and the
 * segment builder has to be able to tell them apart.
 */
alter table public.customers
  add column if not exists pending_spent_centavos public.centavos not null default 0,
  add column if not exists delivered_orders int not null default 0,
  add column if not exists rts_orders       int not null default 0,
  add column if not exists cancelled_orders int not null default 0,
  add column if not exists first_order_at   timestamptz,
  add column if not exists last_order_at    timestamptz;

/**
 * Where a customer came from, now that a spreadsheet is one of the answers.
 *
 * `import` joins storefront/live/manual/marketplace. Worth widening rather than
 * reusing `manual`: a seller looking at 400 people who arrived in one afternoon
 * needs to know they came out of a Shopee export and not from the shop, because
 * that is the difference between "these people know me" and "these people bought
 * from a listing".
 */
alter table public.customers drop constraint if exists customers_source_check;
alter table public.customers add constraint customers_source_check
  check (source in ('storefront', 'live', 'manual', 'marketplace', 'import'));

comment on column public.customers.total_spent_centavos is
  'Money that arrived: delivered or paid orders. Maintained by trigger from orders — never write it directly.';
comment on column public.customers.pending_spent_centavos is
  'Money promised but not yet realised: placed, packed, in transit. Maintained by trigger.';

create index if not exists customers_last_order_idx
  on public.customers (tenant_id, last_order_at desc nulls last);
create index if not exists customers_spend_idx
  on public.customers (tenant_id, total_spent_centavos desc);

/**
 * Recompute one customer's numbers from the orders themselves.
 *
 * Absolute, not incremental. An incremental counter has to be right on every
 * path that ever touches an order — placement, cancellation, an RTS recorded
 * three days later, a payment webhook arriving at midnight — and it is wrong
 * forever the first time one of them is missed. A recomputation from the ledger
 * cannot drift, and a customer has tens of orders, not millions.
 */
create or replace function public.customer_stats_refresh(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_customer_id is null then return; end if;

  update public.customers c
     set total_orders     = s.total_orders,
         delivered_orders = s.delivered_orders,
         rts_orders       = s.rts_orders,
         cancelled_orders = s.cancelled_orders,
         total_spent_centavos   = s.total_spent,
         pending_spent_centavos = s.pending_spent,
         first_order_at   = s.first_order_at,
         last_order_at    = s.last_order_at
  from (
    select
      -- A cancelled order is not an order the customer placed with you in any
      -- sense a seller cares about, so it is excluded from the count and from
      -- both money columns — but kept as its own counter, because a customer who
      -- cancels four times in a row is worth knowing about.
      count(*) filter (where o.fulfillment_status <> 'cancelled')::int as total_orders,
      count(*) filter (where o.fulfillment_status = 'delivered')::int  as delivered_orders,
      count(*) filter (where o.fulfillment_status = 'rts')::int        as rts_orders,
      count(*) filter (where o.fulfillment_status = 'cancelled')::int  as cancelled_orders,
      coalesce(sum(o.grand_total_centavos) filter (
        where o.fulfillment_status = 'delivered' or o.payment_status = 'paid'), 0) as total_spent,
      coalesce(sum(o.grand_total_centavos) filter (
        where o.fulfillment_status not in ('cancelled', 'rts', 'delivered')
          and o.payment_status <> 'paid'), 0) as pending_spent,
      min(o.placed_at) filter (where o.fulfillment_status <> 'cancelled') as first_order_at,
      max(o.placed_at) filter (where o.fulfillment_status <> 'cancelled') as last_order_at
    from public.orders o
    where o.customer_id = p_customer_id
  ) s
  where c.id = p_customer_id;
end;
$$;

create or replace function public.customers_follow_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Both sides on an update, because an order can be moved to a different
  -- customer by a merge and both totals change when it is.
  if tg_op in ('UPDATE', 'DELETE') and old.customer_id is not null then
    perform public.customer_stats_refresh(old.customer_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.customer_id is not null
     and (tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id) then
    perform public.customer_stats_refresh(new.customer_id);
  end if;
  if tg_op = 'UPDATE' and new.customer_id is not null
     and new.customer_id is not distinct from old.customer_id then
    perform public.customer_stats_refresh(new.customer_id);
  end if;
  return null;
end;
$$;

drop trigger if exists customers_follow_orders on public.orders;
create trigger customers_follow_orders
  after insert or delete or
  update of customer_id, fulfillment_status, payment_status, grand_total_centavos, placed_at
  on public.orders
  for each row execute function public.customers_follow_orders();

/**
 * Reject a direct write to the projection.
 *
 * The same guard `inventory_levels` carries, and here for the same reason: the
 * moment two things can write a cache, the question "why does this say ₱4,300"
 * has no answer. `pg_trigger_depth()` distinguishes the refresh above — which
 * runs inside the orders trigger — from a seller, a script, or a well-meaning
 * `update customers set total_spent_centavos = 0`.
 */
create or replace function public.customers_guard_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;

  if new.total_orders          is distinct from old.total_orders
     or new.delivered_orders   is distinct from old.delivered_orders
     or new.rts_orders         is distinct from old.rts_orders
     or new.cancelled_orders   is distinct from old.cancelled_orders
     or new.total_spent_centavos   is distinct from old.total_spent_centavos
     or new.pending_spent_centavos is distinct from old.pending_spent_centavos
     or new.first_order_at     is distinct from old.first_order_at
     or new.last_order_at      is distinct from old.last_order_at then
    raise exception
      'A customer''s totals are a projection of their orders and cannot be written directly'
      using errcode = 'check_violation', hint = 'customer_stats_readonly';
  end if;
  return new;
end;
$$;

drop trigger if exists customers_guard_stats on public.customers;
create trigger customers_guard_stats
  before update on public.customers
  for each row execute function public.customers_guard_stats();

/**
 * The old hand-rolled increment, removed.
 *
 * Identical to the phase-12 definition but for the last statement, which used to
 * add one to `total_orders` and the grand total to `total_spent_centavos`. The
 * trigger above has already done the arithmetic by the time control returns
 * here, from the orders table rather than from a local variable — so leaving it
 * in would double every storefront purchase, and the guard would raise on it.
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

  -- The customer's totals used to be incremented here, by hand, from a local
  -- variable. Phase 15 made them a projection of the orders table maintained by
  -- trigger, so by the time control reaches this line the arithmetic has already
  -- been done from the ledger — and doing it again would double every storefront
  -- purchase. The guard on `customers` now raises if anything tries.

  return public.order_receipt(v_order_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Saved addresses
-- ---------------------------------------------------------------------------
/**
 * Where a repeat buyer's parcels go.
 *
 * PSGC codes rather than free text, for the reason phase 6 learned the hard way:
 * a "complete" address that is prose is an address a courier cannot route. The
 * province is nullable and always will be — NCR has none, and neither do three
 * independent cities.
 */
create table public.customer_addresses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,

  label     text,
  recipient text not null check (length(btrim(recipient)) between 1 and 120),
  phone     text not null check (phone ~ '^\+63[0-9]{9,10}$'),

  region_code    text not null,
  province_code  text,
  city_code      text not null,
  barangay_code  text not null,
  street         text not null check (length(btrim(street)) between 1 and 200),
  postal_code    text,
  landmark       text,

  is_default boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete cascade
);

create index customer_addresses_customer_idx
  on public.customer_addresses (tenant_id, customer_id);
-- One default per customer, enforced by the index rather than by a trigger that
-- has to remember to unset the other one.
create unique index customer_addresses_default_idx
  on public.customer_addresses (customer_id) where is_default;

create trigger customer_addresses_touch
  before update on public.customer_addresses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------
/**
 * The seller's own words for their own people.
 *
 * Deliberately free-form and deliberately *not* a segment. A tag is a fact
 * somebody typed ("suki", "wholesale", "always asks for discount"); a segment is
 * a question the database answers. Conflating them gives you a tag that silently
 * goes out of date and a segment nobody can edit.
 */
create table public.customer_tags (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  name  text not null check (length(btrim(name)) between 1 and 40),
  colour text not null default 'slate'
    check (colour in ('slate', 'rose', 'amber', 'emerald', 'sky', 'violet')),

  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.customer_tag_assignments (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,
  tag_id      uuid not null,
  assigned_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),

  primary key (customer_id, tag_id),
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete cascade,
  foreign key (tenant_id, tag_id)
    references public.customer_tags (tenant_id, id) on delete cascade
);

create index customer_tag_assignments_tag_idx
  on public.customer_tag_assignments (tenant_id, tag_id);

-- ---------------------------------------------------------------------------
-- Segments
-- ---------------------------------------------------------------------------
/**
 * A saved question, not a saved list.
 *
 * The done-when for this phase is a *segment*, and a segment that froze its
 * membership the day it was saved would be wrong by the next morning: somebody
 * orders, somebody's parcel comes back, sixty days tick over. So the definition
 * is stored and the members are computed on every read.
 *
 * `definition` is a small, closed vocabulary — see `customer_segment_match()`.
 * It is never turned into SQL text. A segment builder that concatenates a
 * seller's input into a query is a segment builder that will eventually run one.
 */
create table public.customer_segments (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  name        text not null check (length(btrim(name)) between 1 and 80),
  description text,
  definition  jsonb not null default '{}'::jsonb,

  is_pinned  boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, name)
);

create index customer_segments_tenant_idx
  on public.customer_segments (tenant_id, is_pinned desc, name);

create trigger customer_segments_touch
  before update on public.customer_segments
  for each row execute function public.set_updated_at();

comment on table public.customer_segments is
  'A saved question about customers, answered live. The definition is a closed vocabulary, never SQL text.';

-- ---------------------------------------------------------------------------
-- The segment engine
-- ---------------------------------------------------------------------------
/**
 * Which customers match a definition.
 *
 * ## Why this is one static query and not a query builder
 *
 * The obvious implementation of a segment builder assembles SQL from the
 * seller's criteria. It is also the implementation that eventually runs a
 * seller's text as SQL — and this function is reachable by every signed-in user
 * of the tenant, including a `staff` account somebody's cousin uses. So the
 * definition is a **closed vocabulary**: every key below is read with `->>`,
 * cast to a known type, and compared. Nothing is concatenated, so there is
 * nothing to inject into. Adding a criterion means adding a clause here, which
 * is the point — a criterion nobody wrote cannot be asked for.
 *
 * Each clause is `(the key is absent) or (the predicate)`, so an empty
 * definition means "everybody" and every key narrows. That shape is what lets
 * the UI show a live count while the seller is still building the thing.
 *
 * ## The vocabulary
 *
 *   spentAtLeast / spentAtMost      centavos, on money that actually arrived
 *   ordersAtLeast / ordersAtMost    orders that were not cancelled
 *   orderedWithinDays               bought at least once in the last N days
 *   notOrderedForDays               last order older than N days, or never
 *   boughtCategoryId                bought anything in this category or below it
 *   boughtProductId                 bought this exact product
 *   cityCode                        shipped to this PSGC city, ever
 *   rts                             'none' | 'some'
 *   hasTagId                        carries this tag
 *   source                          where the customer came from
 *
 * `rts = 'none'` deliberately means *zero returned parcels*, not "a low rate".
 * The seller asking for it is about to spend money messaging these people, and
 * "one in ten of these came back" is not the list they asked for.
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
  limit greatest(least(coalesce(p_limit, 100), 500), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

/**
 * The same question, answered as a number.
 *
 * Separate from the list because the builder asks it on every keystroke and the
 * list is fifty rows the seller has not scrolled to yet.
 */
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
          from public.customer_segment_match(p_tenant_id, p_definition, 500, 0));
end;
$$;

/** The list, checked. `customer_segment_match` is the unchecked primitive. */
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
              from public.customer_segment_match(p_tenant_id, p_definition, 500, 0)),
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

/**
 * Save one, and read it back with its live count.
 *
 * The count is computed at read time rather than stored, for the reason the
 * table comment gives: a segment is a question. A stored count is the answer to
 * the question as it was yesterday, which is exactly the number a seller would
 * make a decision on.
 */
create or replace function public.customer_segment_save(
  p_tenant_id   uuid,
  p_name        text,
  p_definition  jsonb,
  p_id          uuid default null,
  p_description text default null,
  p_pinned      boolean default false
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
    insert into public.customer_segments
      (tenant_id, name, description, definition, is_pinned, created_by)
    values (p_tenant_id, btrim(p_name), p_description,
            coalesce(p_definition, '{}'::jsonb), p_pinned, auth.uid())
    returning id into v_id;
  else
    update public.customer_segments
       set name = btrim(p_name),
           description = p_description,
           definition = coalesce(p_definition, '{}'::jsonb),
           is_pinned = p_pinned
     where id = p_id and tenant_id = p_tenant_id
    returning id into v_id;
  end if;

  return v_id;
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
                from public.customer_segment_match(p_tenant_id, s.definition, 500, 0)),
      'updatedAt', s.updated_at)
      order by s.is_pinned desc, s.name)
    from public.customer_segments s
    where s.tenant_id = p_tenant_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- One customer, in full
-- ---------------------------------------------------------------------------
/**
 * Everything the seller needs before they type a message.
 *
 * One round trip, like every other detail screen in this codebase: order
 * history, the money split into arrived and promised, the RTS rate, the tags,
 * the saved addresses. A seller opening a customer is deciding whether to chase
 * a repeat order, and five queries is five chances for one to be slow.
 */
create or replace function public.customer_profile(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_c record;
begin
  select * into v_c from public.customers where id = p_customer_id;
  if v_c.id is null then return null; end if;
  if not public.is_tenant_member(v_c.tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'id', v_c.id, 'name', v_c.name, 'phone', v_c.phone, 'email', v_c.email,
    'source', v_c.source, 'notes', v_c.notes, 'fbPsid', v_c.fb_psid,
    'createdAt', v_c.created_at,
    'stats', jsonb_build_object(
      'orders', v_c.total_orders,
      'delivered', v_c.delivered_orders,
      'rts', v_c.rts_orders,
      'cancelled', v_c.cancelled_orders,
      'spent', v_c.total_spent_centavos,
      'pending', v_c.pending_spent_centavos,
      'firstOrderAt', v_c.first_order_at,
      'lastOrderAt', v_c.last_order_at,
      -- Out of parcels that reached a conclusion, not out of everything ever
      -- placed: an order still in a van is not evidence either way.
      'rtsRateBps', case
        when (v_c.delivered_orders + v_c.rts_orders) = 0 then 0
        else round(v_c.rts_orders::numeric * 10000
                   / (v_c.delivered_orders + v_c.rts_orders))::int
      end),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour)
             order by t.name)
      from public.customer_tag_assignments a
        join public.customer_tags t on t.id = a.tag_id
      where a.customer_id = v_c.id), '[]'::jsonb),
    'addresses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'label', a.label, 'recipient', a.recipient, 'phone', a.phone,
        'street', a.street, 'cityCode', a.city_code, 'barangayCode', a.barangay_code,
        'cityName', (select display_name from public.psgc_cities where code = a.city_code),
        'barangayName', (select name from public.psgc_barangays where code = a.barangay_code),
        'isDefault', a.is_default) order by a.is_default desc, a.created_at)
      from public.customer_addresses a where a.customer_id = v_c.id), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'number', o.order_number, 'placedAt', o.placed_at,
        'total', o.grand_total_centavos, 'paymentStatus', o.payment_status,
        'fulfillmentStatus', o.fulfillment_status, 'source', o.source,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object('name', oi.product_name, 'qty', oi.qty)
                 order by oi.created_at)
          from public.order_items oi where oi.order_id = o.id), '[]'::jsonb))
        order by o.placed_at desc)
      from (select * from public.orders where customer_id = v_c.id
            order by placed_at desc limit 50) o), '[]'::jsonb));
end;
$$;

/**
 * The list behind the search box.
 *
 * Phone search normalises **both sides**. Numbers are stored `+639171234567`; a
 * seller types `09171234567`, and neither digit string contains the other. That
 * bug made the single most likely query anyone would make return nothing, and it
 * is the same fix phase 9 applied to order search.
 */
create or replace function public.customers_list(
  p_tenant_id uuid,
  p_search    text default null,
  p_sort      text default 'recent',
  p_limit     int default 50,
  p_offset    int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query  text := btrim(coalesce(p_search, ''));
  v_digits text;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- A floor of five digits: at four, `0001` matched the `00010`…`00019` inside
  -- other people's phone numbers.
  v_digits := public.ph_national_digits(v_query);
  if length(coalesce(v_digits, '')) < 5 then v_digits := null; end if;

  return jsonb_build_object(
    'total', (select count(*)::int from public.customers c
              where c.tenant_id = p_tenant_id
                and (v_query = ''
                     or c.name ilike '%' || v_query || '%'
                     or (v_digits is not null
                         and public.ph_national_digits(c.phone) like '%' || v_digits || '%'))),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
        'orders', c.total_orders, 'delivered', c.delivered_orders, 'rts', c.rts_orders,
        'spent', c.total_spent_centavos, 'pending', c.pending_spent_centavos,
        'lastOrderAt', c.last_order_at, 'source', c.source,
        'tags', coalesce((
          select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour))
          from public.customer_tag_assignments a
            join public.customer_tags t on t.id = a.tag_id
          where a.customer_id = c.id), '[]'::jsonb))
        order by
          case when p_sort = 'spend'  then c.total_spent_centavos end desc nulls last,
          case when p_sort = 'orders' then c.total_orders end desc nulls last,
          case when p_sort = 'name'   then c.name end asc nulls last,
          case when p_sort not in ('spend','orders','name') then c.last_order_at end desc nulls last)
      from (
        select * from public.customers c
        where c.tenant_id = p_tenant_id
          and (v_query = ''
               or c.name ilike '%' || v_query || '%'
               or (v_digits is not null
                   and public.ph_national_digits(c.phone) like '%' || v_digits || '%'))
        order by
          case when p_sort = 'spend'  then c.total_spent_centavos end desc nulls last,
          case when p_sort = 'orders' then c.total_orders end desc nulls last,
          case when p_sort = 'name'   then c.name end asc nulls last,
          case when p_sort not in ('spend','orders','name') then c.last_order_at end desc nulls last
        limit greatest(least(coalesce(p_limit, 50), 200), 1)
        offset greatest(coalesce(p_offset, 0), 0)
      ) c), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Two people who are one person
-- ---------------------------------------------------------------------------
/**
 * One PH mobile number, in the one form the rest of the schema uses.
 *
 * `+639171234567`, or null. Everything that arrives from a spreadsheet is some
 * other shape — `09171234567`, `9171234567`, `+63 917 123 4567`, `63917-123
 * 4567`, and once, memorably, `9.17123E+11` — and a customer list that stores
 * four spellings of one number is a customer list with four of that person in
 * it. `customers` is unique on `(tenant_id, phone)`, so normalising on the way
 * in is what makes that constraint mean "one person" rather than "one string".
 */
create or replace function public.ph_phone_e164(p_input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when public.ph_national_digits(p_input) ~ '^9[0-9]{9}$'
      then '+63' || public.ph_national_digits(p_input)
    else null
  end;
$$;

/**
 * Merge two customers into one.
 *
 * `customers` is unique on `(tenant_id, phone)`, so duplicates cannot be two
 * rows with the *same* phone — they are two rows with the same *person*, whose
 * number was written two ways before it was normalised, or who ordered once as
 * "Rhea" and once as "Rhea S.". So the merge takes two ids and is deliberately
 * a seller's decision rather than an automatic sweep: "same phone" is a fact,
 * "same person" is a judgement, and merging the wrong two is not reversible.
 *
 * Everything that points at the loser is repointed, not copied — orders, carts,
 * saved addresses, Messenger threads, tags. The stats then recompute themselves,
 * because they are a projection and there is nothing to add up by hand.
 */
create or replace function public.customers_merge(p_keep_id uuid, p_merge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep  record;
  v_merge record;
  v_moved int;
begin
  if p_keep_id = p_merge_id then
    raise exception 'A customer cannot be merged into themselves'
      using errcode = 'check_violation';
  end if;

  select * into v_keep  from public.customers where id = p_keep_id;
  select * into v_merge from public.customers where id = p_merge_id;

  if v_keep.id is null or v_merge.id is null then
    raise exception 'Customer not found' using errcode = 'no_data_found';
  end if;
  if v_keep.tenant_id <> v_merge.tenant_id then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not public.has_tenant_role(v_keep.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  update public.orders set customer_id = p_keep_id where customer_id = p_merge_id;
  get diagnostics v_moved = row_count;

  update public.carts             set customer_id = p_keep_id where customer_id = p_merge_id;
  update public.customer_addresses
     set customer_id = p_keep_id,
         -- Only one address can be the default, and the survivor's wins.
         is_default = false
   where customer_id = p_merge_id;
  update public.message_threads   set customer_id = p_keep_id where customer_id = p_merge_id;

  insert into public.customer_tag_assignments (tenant_id, customer_id, tag_id)
  select tenant_id, p_keep_id, tag_id from public.customer_tag_assignments
  where customer_id = p_merge_id
  on conflict do nothing;

  -- Keep whatever the survivor is missing. A merge should never lose a fact.
  update public.customers
     set email   = coalesce(email, v_merge.email),
         fb_psid = coalesce(fb_psid, v_merge.fb_psid),
         notes   = case
                     when coalesce(btrim(v_merge.notes), '') = '' then notes
                     when coalesce(btrim(notes), '') = '' then v_merge.notes
                     else notes || E'\n' || v_merge.notes
                   end
   where id = p_keep_id;

  delete from public.customers where id = p_merge_id;

  perform public.customer_stats_refresh(p_keep_id);

  return jsonb_build_object('id', p_keep_id, 'ordersMoved', v_moved);
end;
$$;

/**
 * Import a list of people.
 *
 * The rows arrive already parsed — the CSV and XLSX reading, and the guessing at
 * which column of a Shopee export is a phone number, happen in TypeScript where
 * there is a corpus to score against. What happens here is the part that must
 * not be wrong: normalise the number, refuse the rows that are not numbers, and
 * upsert without ever overwriting something real with something blank.
 *
 * Returns counts rather than raising, because an import of 400 rows with 3 bad
 * ones should load 397 and *say so*. An all-or-nothing import of a spreadsheet
 * somebody exported from Shopee is an import that never succeeds.
 */
create or replace function public.customers_import(
  p_tenant_id uuid,
  p_rows      jsonb,
  p_source    text default 'import',
  p_tag_name  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     jsonb;
  v_phone   text;
  v_name    text;
  v_id      uuid;
  v_new     boolean;
  v_tag_id  uuid;
  v_created int := 0;
  v_updated int := 0;
  v_invalid int := 0;
  v_seen    text[] := '{}';
  v_dupes   int := 0;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  if p_tag_name is not null and btrim(p_tag_name) <> '' then
    insert into public.customer_tags (tenant_id, name)
    values (p_tenant_id, btrim(p_tag_name))
    on conflict (tenant_id, name) do update set name = excluded.name
    returning id into v_tag_id;
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_phone := public.ph_phone_e164(v_row ->> 'phone');
    v_name  := nullif(btrim(coalesce(v_row ->> 'name', '')), '');

    if v_phone is null or v_name is null then
      v_invalid := v_invalid + 1;
      continue;
    end if;

    -- The same person twice in one file is one person. Counted, not silently
    -- collapsed: a seller who exported overlapping date ranges wants to know.
    if v_phone = any (v_seen) then
      v_dupes := v_dupes + 1;
      continue;
    end if;
    v_seen := v_seen || v_phone;

    insert into public.customers (tenant_id, name, phone, email, source, notes)
    values (p_tenant_id, v_name, v_phone,
            nullif(btrim(coalesce(v_row ->> 'email', '')), ''),
            p_source,
            nullif(btrim(coalesce(v_row ->> 'note', '')), ''))
    on conflict (tenant_id, phone) do update
      -- The name is taken from the file, because a row with a blank one never
      -- reaches here — the skip above drops it as `invalid` rather than letting
      -- an empty name near a customer who has one. What *is* guarded here is
      -- everything the file may simply not have a column for: an export with no
      -- email must not erase the email the seller already had.
      set name  = excluded.name,
          email = coalesce(public.customers.email, excluded.email),
          notes = coalesce(public.customers.notes, excluded.notes)
    -- `xmax = 0` is how Postgres tells an INSERT from an UPDATE inside an upsert.
    -- Worth the trick: "we added 43 people and recognised 357" is the sentence a
    -- seller needs after importing a marketplace export.
    returning id, (xmax = 0) into v_id, v_new;

    if v_new then v_created := v_created + 1;
    else v_updated := v_updated + 1;
    end if;

    if v_tag_id is not null then
      insert into public.customer_tag_assignments (tenant_id, customer_id, tag_id)
      values (p_tenant_id, v_id, v_tag_id)
      on conflict do nothing;
    end if;
  end loop;

  return jsonb_build_object(
    'created', v_created, 'updated', v_updated,
    'invalid', v_invalid, 'duplicatesInFile', v_dupes,
    'tagId', v_tag_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.customer_addresses        enable row level security;
alter table public.customer_addresses        force  row level security;
alter table public.customer_tags             enable row level security;
alter table public.customer_tags             force  row level security;
alter table public.customer_tag_assignments  enable row level security;
alter table public.customer_tag_assignments  force  row level security;
alter table public.customer_segments         enable row level security;
alter table public.customer_segments         force  row level security;

create policy "Members read addresses" on public.customer_addresses for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write addresses" on public.customer_addresses for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update addresses" on public.customer_addresses for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete addresses" on public.customer_addresses for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

create policy "Members read tags" on public.customer_tags for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write tags" on public.customer_tags for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update tags" on public.customer_tags for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete tags" on public.customer_tags for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

create policy "Members read tag links" on public.customer_tag_assignments for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write tag links" on public.customer_tag_assignments for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete tag links" on public.customer_tag_assignments for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

create policy "Members read segments" on public.customer_segments for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write segments" on public.customer_segments for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update segments" on public.customer_segments for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete segments" on public.customer_segments for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.customer_addresses       to authenticated;
grant select, insert, update, delete on public.customer_tags            to authenticated;
grant select, insert, delete         on public.customer_tag_assignments to authenticated;
grant select, insert, update, delete on public.customer_segments        to authenticated;

grant execute on function public.customers_list(uuid, text, text, int, int) to authenticated;
grant execute on function public.customer_profile(uuid)                     to authenticated;
grant execute on function public.customer_segment_preview(uuid, jsonb, int, int) to authenticated;
grant execute on function public.customer_segment_count(uuid, jsonb)        to authenticated;
grant execute on function public.customer_segment_save(uuid, text, jsonb, uuid, text, boolean) to authenticated;
grant execute on function public.customer_segments_list(uuid)               to authenticated;
grant execute on function public.customers_merge(uuid, uuid)                to authenticated;
grant execute on function public.customers_import(uuid, jsonb, text, text)  to authenticated;

/**
 * `revoke ... from public` first, then grant — the trap this codebase has now
 * paid for twice.
 *
 * Postgres grants EXECUTE on every new function to **PUBLIC**, so a grant to
 * `authenticated` alone leaves the function callable by `anon`. Each of these
 * checks membership internally and would refuse a caller with no session, but
 * "reachable by anyone on the internet" is not the posture for a function that
 * reads a store's entire customer list.
 */
revoke all on function public.customers_list(uuid, text, text, int, int) from public;
revoke all on function public.customer_profile(uuid)                     from public;
revoke all on function public.customer_segment_preview(uuid, jsonb, int, int) from public;
revoke all on function public.customer_segment_count(uuid, jsonb)        from public;
revoke all on function public.customer_segment_save(uuid, text, jsonb, uuid, text, boolean) from public;
revoke all on function public.customer_segments_list(uuid)               from public;
revoke all on function public.customers_merge(uuid, uuid)                from public;
revoke all on function public.customers_import(uuid, jsonb, text, text)  from public;

grant execute on function public.customers_list(uuid, text, text, int, int) to authenticated;
grant execute on function public.customer_profile(uuid)                     to authenticated;
grant execute on function public.customer_segment_preview(uuid, jsonb, int, int) to authenticated;
grant execute on function public.customer_segment_count(uuid, jsonb)        to authenticated;
grant execute on function public.customer_segment_save(uuid, text, jsonb, uuid, text, boolean) to authenticated;
grant execute on function public.customer_segments_list(uuid)               to authenticated;
grant execute on function public.customers_merge(uuid, uuid)                to authenticated;
grant execute on function public.customers_import(uuid, jsonb, text, text)  to authenticated;

/**
 * The unchecked primitives, granted to nobody.
 *
 * `customer_segment_match` takes a tenant id and returns that tenant's people;
 * it is the body the checked wrappers call. `customer_stats_refresh` writes the
 * projection. Neither has any business being callable with a session.
 */
revoke all on function public.customer_segment_match(uuid, jsonb, int, int) from public;
revoke all on function public.customer_stats_refresh(uuid)                  from public;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
/**
 * Recompute every existing customer.
 *
 * Not cosmetic: until this runs, `total_spent_centavos` is whatever the old
 * hand-rolled increments left behind — cancelled orders included, RTS parcels
 * counted as revenue, and anything written by another route missing entirely.
 * The first segment a seller builds would be answered from those numbers.
 */
do $$
declare v_id uuid;
begin
  for v_id in select id from public.customers loop
    perform public.customer_stats_refresh(v_id);
  end loop;
end;
$$;
