-- ---------------------------------------------------------------------------
-- Phase 6 — cart and guest checkout
-- ---------------------------------------------------------------------------
-- The security model here is different from every phase before it, and that
-- difference is the whole design.
--
-- Everywhere else the boundary is `is_tenant_member(tenant_id)`: the caller is a
-- signed-in seller and we ask which tenant they belong to. A buyer is anonymous
-- by design — no account, no JWT, nothing to check membership against. So the
-- boundary becomes **the cart token**: a 256-bit secret in an httpOnly cookie.
--
-- Consequences, all deliberate:
--
--   * `anon` gets NO table grants on carts, cart_items, orders or customers.
--     Everything goes through SECURITY DEFINER functions that take the token and
--     validate it first. A buyer cannot SELECT their own cart row; they call
--     `cart_view(token)`.
--   * The token is never readable through any policy — same rule as
--     `invitations.token` in phase 1. A bearer credential that can be SELECTed is
--     not a credential.
--   * Sellers read orders through ordinary member-scoped RLS, because for them
--     the normal boundary applies.
--
-- And the rule that matters most (hard rule 6): **prices are recomputed
-- server-side at checkout, from the database, every time.** `cart_items` stores a
-- price snapshot, but that snapshot is for showing a buyer what changed — it is
-- never what they are charged. `cart_pricing()` is the single source of the
-- numbers, and both the quote the buyer sees and the order that gets written go
-- through it, so the two cannot disagree.

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 120),
  -- Normalised to +63 E.164 by the application (src/lib/phone). The check keeps a
  -- raw "0917…" out of the column, because phone is how a seller finds a customer
  -- and two spellings of one number are two customers.
  phone                text not null check (phone ~ '^\+63[0-9]{9,10}$'),
  email                text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  fb_psid              text,
  source               text not null default 'storefront'
                         check (source in ('storefront', 'live', 'manual', 'marketplace')),
  total_orders         int not null default 0 check (total_orders >= 0),
  total_spent_centavos public.centavos not null default 0 check (total_spent_centavos >= 0),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- One customer per phone per store. This is what makes a returning buyer
  -- recognisable at all, and what stops a second order creating a second person.
  unique (tenant_id, phone),
  unique (tenant_id, id)
);

create index customers_tenant_idx on public.customers (tenant_id);
create index customers_phone_idx  on public.customers (tenant_id, phone);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

comment on table public.customers is
  'Buyers, keyed by phone per tenant. Created by checkout; no account required.';

-- ---------------------------------------------------------------------------
-- carts
-- ---------------------------------------------------------------------------
create table public.carts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  -- The credential. 32 random bytes, hex. Never exposed by a SELECT policy.
  token       text not null unique
                check (token ~ '^[0-9a-f]{64}$'),
  customer_id uuid,
  status      text not null default 'active'
                check (status in ('active', 'converted', 'abandoned', 'expired')),
  source      text not null default 'storefront'
                check (source in ('storefront', 'live', 'manual', 'marketplace')),
  -- A cart is not forever. Abandoned-cart recovery (phase 11) reads this.
  expires_at  timestamptz not null default now() + interval '30 days',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null
);

create index carts_tenant_idx  on public.carts (tenant_id);
create index carts_status_idx  on public.carts (tenant_id, status);
create index carts_expiry_idx  on public.carts (expires_at) where status = 'active';

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function public.set_updated_at();

comment on table public.carts is
  'Guest carts. `token` is a bearer credential — no SELECT policy exposes it, and all buyer access goes through SECURITY DEFINER functions.';

create table public.cart_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  cart_id             uuid not null,
  variant_id          uuid not null,
  qty                 int not null check (qty > 0 and qty <= 999),
  -- A SNAPSHOT, for display only. Never used to charge. See cart_pricing().
  unit_price_centavos public.centavos not null check (unit_price_centavos >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One line per variant. Adding the same variant twice bumps qty instead.
  unique (cart_id, variant_id),
  foreign key (tenant_id, cart_id)
    references public.carts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index cart_items_cart_idx on public.cart_items (cart_id);

create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

comment on column public.cart_items.unit_price_centavos is
  'Price when added, for showing a buyer that something changed. NOT what they are charged — checkout re-reads the live price.';

-- ---------------------------------------------------------------------------
-- Order numbering
-- ---------------------------------------------------------------------------
-- Sellers read these aloud on calls, so they are short and per-tenant rather
-- than a global uuid.
--
-- A counter in `tenant_settings` would race: two concurrent checkouts would read
-- the same value and both write the same number. A dedicated row updated with
-- `UPDATE … RETURNING` takes a row lock, which serialises numbering per tenant
-- and only per tenant.
create table public.order_counters (
  tenant_id   uuid primary key references public.tenants (id) on delete cascade,
  next_number bigint not null default 1 check (next_number > 0)
);

comment on table public.order_counters is
  'Per-tenant order number sequence. Updated with UPDATE … RETURNING so concurrent checkouts cannot take the same number.';

create or replace function public.next_order_number(p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
  v_prefix text;
begin
  -- Create the counter lazily so a tenant made before this migration works.
  insert into public.order_counters (tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;

  update public.order_counters
     set next_number = next_number + 1
   where tenant_id = p_tenant_id
  returning next_number - 1 into v_number;

  select coalesce(value #>> '{}', '') into v_prefix
  from public.tenant_settings
  where tenant_id = p_tenant_id and key = 'orders.number_prefix';

  -- Zero-padded to 4 so early orders do not look like test data.
  return coalesce(nullif(btrim(v_prefix), ''), '') || lpad(v_number::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  order_number       text not null check (length(btrim(order_number)) between 1 and 40),
  customer_id        uuid,
  cart_id            uuid,

  -- A SNAPSHOT, not a reference. PSA renames places, and couriers dispute
  -- deliveries months later — the address on the order must be the address as it
  -- was written, not as PSGC reads today. Codes are kept alongside for zone
  -- matching and courier booking.
  shipping_address   jsonb not null,

  contact_name       text not null check (length(btrim(contact_name)) between 1 and 120),
  contact_phone      text not null check (contact_phone ~ '^\+63[0-9]{9,10}$'),
  contact_email      text,

  subtotal_centavos       public.centavos not null check (subtotal_centavos >= 0),
  discount_total_centavos public.centavos not null default 0 check (discount_total_centavos >= 0),
  shipping_total_centavos public.centavos not null default 0 check (shipping_total_centavos >= 0),
  cod_fee_centavos        public.centavos not null default 0 check (cod_fee_centavos >= 0),
  grand_total_centavos    public.centavos not null check (grand_total_centavos >= 0),

  payment_method     text not null
                       check (payment_method in ('cod','gcash','maya','card','bank','qrph')),
  payment_status     text not null default 'unpaid'
                       check (payment_status in ('unpaid','paid','partial','refunded')),
  fulfillment_status text not null default 'pending'
                       check (fulfillment_status in
                         ('pending','confirmed','packed','shipped','delivered','rts','cancelled')),

  source             text not null default 'storefront'
                       check (source in ('storefront','live','manual','marketplace')),
  channel_ref        text,
  notes              text,
  cancelled_reason   text,

  -- Where the stock was reserved from, so a cancellation knows what to release.
  location_id        uuid,

  placed_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (tenant_id, order_number),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null,
  foreign key (tenant_id, cart_id)
    references public.carts (tenant_id, id) on delete set null,

  -- The arithmetic is asserted at the schema level, not just in the function that
  -- writes it. If a future code path computes a total in application code and
  -- writes it here, this rejects it.
  constraint orders_total_adds_up check (
    grand_total_centavos
      = subtotal_centavos - discount_total_centavos
        + shipping_total_centavos + cod_fee_centavos
  ),
  constraint orders_discount_within_subtotal check (discount_total_centavos <= subtotal_centavos)
);

create index orders_tenant_idx        on public.orders (tenant_id, placed_at desc);
create index orders_fulfillment_idx   on public.orders (tenant_id, fulfillment_status);
create index orders_payment_idx       on public.orders (tenant_id, payment_status);
create index orders_customer_idx      on public.orders (tenant_id, customer_id);
create index orders_phone_idx         on public.orders (tenant_id, contact_phone);
create index orders_number_idx        on public.orders (tenant_id, order_number);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

comment on constraint orders_total_adds_up on public.orders is
  'The grand total must equal its parts. Cheap insurance against a future path that computes money in application code.';

create table public.order_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  order_id            uuid not null,
  variant_id          uuid,

  -- Snapshots. A seller renaming a product must not rewrite history, and a
  -- deleted variant must not erase what was sold.
  product_name        text not null,
  variant_label       text,
  sku                 text,

  qty                 int not null check (qty > 0),
  unit_price_centavos public.centavos not null check (unit_price_centavos >= 0),
  -- Snapshotted so margin reporting stays correct after the cost changes. Never
  -- exposed to a buyer — see the storefront projections.
  cost_centavos       public.centavos,
  line_total_centavos public.centavos not null check (line_total_centavos >= 0),

  created_at          timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete set null,
  foreign key (tenant_id) references public.tenants (id) on delete cascade,

  constraint order_items_line_total_adds_up
    check (line_total_centavos = unit_price_centavos * qty)
);

create index order_items_order_idx on public.order_items (order_id);

create table public.order_status_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  order_id    uuid not null,
  field       text not null check (field in ('fulfillment_status', 'payment_status')),
  from_status text,
  to_status   text not null,
  actor_id    uuid references public.profiles (id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),

  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

create index order_status_history_order_idx
  on public.order_status_history (order_id, created_at);

comment on table public.order_status_history is
  'Append-only audit of status transitions. Phase 9 drives the pipeline; phase 6 writes the first row.';

-- ---------------------------------------------------------------------------
-- Reservation, without the membership check
-- ---------------------------------------------------------------------------
-- Phase 4's `reserve_stock()` starts with `is_tenant_member(p_tenant_id)`, which
-- is exactly right for a seller adjusting stock and exactly wrong for a guest
-- checkout: the buyer is not a member of anything.
--
-- Rather than reimplement the reservation (and with it the sorted advisory locks
-- that keep two concurrent carts from deadlocking), the mechanics move into an
-- internal function and both callers share it. The concurrency suite therefore
-- still exercises the same code path the storefront uses.
--
-- SECURITY: this function performs NO authorisation. Every caller must establish
-- its own — membership for a seller, a valid cart token for a buyer.
create or replace function public.apply_reservation(
  p_tenant_id   uuid,
  p_location_id uuid,
  p_items       jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item    record;
  v_variant uuid;
  v_updated int;
begin
  -- Sorted lock acquisition. Two carts holding {A,B} and {B,A} and locking in
  -- arrival order deadlock, and Postgres kills one — a failed checkout for a
  -- buyer who did nothing wrong.
  for v_variant in
    select distinct (value ->> 'variant_id')::uuid as variant_id
    from jsonb_array_elements(p_items) as value
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_variant::text, 0));
  end loop;

  for v_item in
    select (value ->> 'variant_id')::uuid as variant_id,
           (value ->> 'qty')::int         as qty
    from jsonb_array_elements(p_items) as value
  loop
    if v_item.qty is null or v_item.qty <= 0 then
      raise exception 'Reservation quantity must be positive, got %', v_item.qty
        using errcode = 'check_violation';
    end if;

    -- The availability test is IN the UPDATE predicate, so the read and the write
    -- are one atomic statement.
    update public.inventory_levels
       set reserved = reserved + v_item.qty
     where variant_id = v_item.variant_id
       and location_id = p_location_id
       and tenant_id = p_tenant_id
       and on_hand - reserved >= v_item.qty;

    get diagnostics v_updated = row_count;

    if v_updated = 0 then
      raise exception 'Insufficient stock for variant % (requested %)',
        v_item.variant_id, v_item.qty
        using errcode = 'check_violation',
              hint = 'insufficient_stock';
    end if;
  end loop;
end;
$$;

comment on function public.apply_reservation(uuid, uuid, jsonb) is
  'Reservation mechanics with NO authorisation check. Callers must authorise. Shared by reserve_stock (members) and checkout (cart token).';

-- reserve_stock keeps its signature and behaviour; only the body is now a
-- membership check plus a delegation.
create or replace function public.reserve_stock(
  p_tenant_id      uuid,
  p_location_id    uuid,
  p_items          jsonb,
  p_reference_type text default 'order',
  p_reference_id   uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not a member of this tenant' using errcode = 'insufficient_privilege';
  end if;

  perform public.apply_reservation(p_tenant_id, p_location_id, p_items);
end;
$$;

revoke all on function public.apply_reservation(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- New tenant setting: flat shipping
-- ---------------------------------------------------------------------------
-- Phase 7 owns real shipping (zones, weight tiers, live courier quotes). Checkout
-- cannot wait for it, so this phase resolves one flat rate per tenant and phase 7
-- replaces the resolver — not the checkout flow.
--
-- The key is declared in src/lib/settings/keys.ts as well; the table is key/value
-- so nothing in the database stops a typo'd key, and that file is the compensating
-- control.
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
    (new.id, 'onboarding.step', '1'::jsonb),
    (new.id, 'onboarding.completed_at', 'null'::jsonb),
    (new.id, 'payments.cod_enabled', 'true'::jsonb),
    (new.id, 'payments.cod_fee_centavos', '0'::jsonb),
    (new.id, 'payments.cod_fee_bps', '0'::jsonb),
    (new.id, 'payments.online_enabled', 'false'::jsonb),
    (new.id, 'orders.number_prefix', '""'::jsonb),
    (new.id, 'orders.auto_confirm', 'false'::jsonb),
    (new.id, 'catalog.presets', '[]'::jsonb),
    -- Phase 6. ₱80 is the going rate for Metro Manila small-parcel COD, and a
    -- default of 0 would silently ship everything free.
    (new.id, 'shipping.flat_centavos', '8000'::jsonb)
  on conflict (tenant_id, key) do nothing;

  -- Order numbering starts at 1 for every tenant.
  insert into public.order_counters (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;

  return new;
end;
$$;

-- Backfill tenants that predate this migration.
insert into public.tenant_settings (tenant_id, key, value)
select t.id, 'shipping.flat_centavos', '8000'::jsonb from public.tenants t
on conflict (tenant_id, key) do nothing;

insert into public.order_counters (tenant_id)
select t.id from public.tenants t
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- Pricing — the one place money is computed
-- ---------------------------------------------------------------------------
-- Hard rule 6: never trust client-side prices; recompute every cart total
-- server-side at checkout.
--
-- This function IS that recomputation, and it is shared by the quote the buyer
-- sees and the order that gets written. That sharing is the point: two
-- implementations would drift, and the way that failure presents is a buyer
-- charged a different number from the one they agreed to.
--
-- Every unit price is read live from `product_variants`. `cart_items.unit_price_centavos`
-- is deliberately not consulted.
create or replace function public.cart_pricing(
  p_cart_id        uuid,
  p_payment_method text default 'cod'
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
  v_shipping    bigint := 0;
  v_cod_flat    bigint := 0;
  v_cod_bps     bigint := 0;
  v_cod_fee     bigint := 0;
  v_discount    bigint := 0;
  v_items       jsonb;
  v_count       int := 0;
begin
  select tenant_id into v_tenant_id from public.carts where id = p_cart_id;
  if v_tenant_id is null then
    return null;
  end if;

  -- Line items, priced live. `priceChanged` lets the cart page tell a buyer that
  -- something moved since they added it rather than silently charging the new
  -- number.
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
      'image',         img.storage_path,
      'renditions',    coalesce(to_jsonb(img.renditions), '[]'::jsonb)
    ) order by ci.created_at, ci.id), '[]'::jsonb),
    coalesce(sum(v.price_centavos * ci.qty), 0),
    coalesce(sum(ci.qty), 0)
  into v_items, v_subtotal, v_count
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

  -- Shipping. Phase 7 replaces this lookup with zone resolution.
  select coalesce((value #>> '{}')::bigint, 0) into v_shipping
  from public.tenant_settings
  where tenant_id = v_tenant_id and key = 'shipping.flat_centavos';
  v_shipping := coalesce(v_shipping, 0);

  -- COD fee applies only to COD. Flat plus a rate on the subtotal.
  if p_payment_method = 'cod' then
    select coalesce((value #>> '{}')::bigint, 0) into v_cod_flat
    from public.tenant_settings
    where tenant_id = v_tenant_id and key = 'payments.cod_fee_centavos';

    select coalesce((value #>> '{}')::bigint, 0) into v_cod_bps
    from public.tenant_settings
    where tenant_id = v_tenant_id and key = 'payments.cod_fee_bps';

    -- Half away from zero, matching `applyBps` in src/lib/money. Postgres
    -- `round(numeric)` rounds halves away from zero, and every amount here is
    -- non-negative, so the two agree. Integer division would not.
    v_cod_fee := coalesce(v_cod_flat, 0)
      + round((v_subtotal::numeric * coalesce(v_cod_bps, 0)) / 10000)::bigint;
  end if;

  -- An empty cart has no shipping and no fee — quoting ₱80 to ship nothing is how
  -- a buyer decides the store is broken.
  if v_count = 0 then
    v_shipping := 0;
    v_cod_fee  := 0;
  end if;

  return jsonb_build_object(
    'cartId',        p_cart_id,
    'paymentMethod', p_payment_method,
    'itemCount',     v_count,
    'items',         v_items,
    'subtotal',      v_subtotal,
    'discountTotal', v_discount,
    'shippingTotal', v_shipping,
    'codFee',        v_cod_fee,
    'grandTotal',    v_subtotal - v_discount + v_shipping + v_cod_fee
  );
end;
$$;

comment on function public.cart_pricing(uuid, text) is
  'Server-side recomputation of every cart total from live prices. Shared by the buyer-facing quote and by checkout so the two cannot disagree.';

-- ---------------------------------------------------------------------------
-- Cart operations, authorised by token
-- ---------------------------------------------------------------------------
-- Each of these validates the token and returns the cart's state. A buyer never
-- touches a table directly.

/** Mint a cart for a store. The caller stores the token in an httpOnly cookie. */
create or replace function public.cart_create(p_slug text default null, p_domain text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_token     text;
begin
  v_tenant_id := public.storefront_tenant_id(p_slug, p_domain);
  if v_tenant_id is null then
    raise exception 'No such store' using errcode = 'no_data_found';
  end if;

  -- 32 bytes of CSPRNG. This is the only thing standing between one buyer's cart
  -- and another's, so it is not a sequence and not a uuid v4 rendered as text.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.carts (tenant_id, token) values (v_tenant_id, v_token);
  return v_token;
end;
$$;

/**
 * Resolve a token to a cart id, or null.
 *
 * Internal. Also the place where an expired cart stops being usable, so no caller
 * has to remember to check.
 */
create or replace function public.cart_id_for_token(p_token text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.carts c
  where c.token = p_token
    and c.status = 'active'
    and c.expires_at > now()
  limit 1;
$$;

/** The cart as the buyer should see it: live prices, totals, stock state. */
create or replace function public.cart_view(p_token text, p_payment_method text default 'cod')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
begin
  v_cart_id := public.cart_id_for_token(p_token);
  if v_cart_id is null then
    return null;
  end if;
  return public.cart_pricing(v_cart_id, p_payment_method);
end;
$$;

/**
 * Add a variant, or increase its quantity.
 *
 * Note what is NOT a parameter: a price. The snapshot is read from the database,
 * so a crafted request cannot introduce a price of its own even into the column
 * that is only used for display.
 */
create or replace function public.cart_add_item(
  p_token      text,
  p_variant_id uuid,
  p_qty        int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id   uuid;
  v_tenant_id uuid;
  v_price     bigint;
  v_qty       int := greatest(1, least(coalesce(p_qty, 1), 999));
begin
  v_cart_id := public.cart_id_for_token(p_token);
  if v_cart_id is null then
    raise exception 'Cart not found' using errcode = 'no_data_found';
  end if;

  select tenant_id into v_tenant_id from public.carts where id = v_cart_id;

  -- The variant must belong to this cart's tenant AND be publicly purchasable.
  -- Reading through storefront_variants rather than product_variants is what stops
  -- a draft product, or another store's variant, being added by id.
  select v.price_centavos into v_price
  from public.storefront_variants v
  where v.id = p_variant_id and v.tenant_id = v_tenant_id;

  if v_price is null then
    raise exception 'Variant % is not available in this store', p_variant_id
      using errcode = 'no_data_found';
  end if;

  insert into public.cart_items (tenant_id, cart_id, variant_id, qty, unit_price_centavos)
  values (v_tenant_id, v_cart_id, p_variant_id, v_qty, v_price)
  on conflict (cart_id, variant_id) do update
    set qty = least(public.cart_items.qty + v_qty, 999),
        -- Refresh the snapshot so "price changed" means "changed since you last
        -- touched this line", which is the only version of that message a buyer
        -- can act on.
        unit_price_centavos = v_price;

  return public.cart_pricing(v_cart_id, 'cod');
end;
$$;

/** Set an exact quantity. Zero removes the line, which is what a stepper at 1 does. */
create or replace function public.cart_set_qty(
  p_token      text,
  p_variant_id uuid,
  p_qty        int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
begin
  v_cart_id := public.cart_id_for_token(p_token);
  if v_cart_id is null then
    raise exception 'Cart not found' using errcode = 'no_data_found';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    delete from public.cart_items where cart_id = v_cart_id and variant_id = p_variant_id;
  else
    update public.cart_items
       set qty = least(p_qty, 999)
     where cart_id = v_cart_id and variant_id = p_variant_id;
  end if;

  return public.cart_pricing(v_cart_id, 'cod');
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout
-- ---------------------------------------------------------------------------
-- One function, one transaction: recompute the money, reserve the stock, record
-- the customer, number the order, write it, and retire the cart. Any failure
-- rolls all of it back, so there is no state where stock is held for an order that
-- does not exist.
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
  v_pricing := public.cart_pricing(v_cart.id, p_payment_method);

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

/**
 * What a buyer may see about their own order.
 *
 * Deliberately excludes `cost_centavos` — that is the seller's margin, and it
 * lives on the same row as everything else here.
 *
 * NOT granted to anon. Taking an order id alone would make the confirmation URL a
 * capability that leaks a name, phone and full address to anyone it is forwarded
 * to. Buyers reach their receipt through `order_receipt_for_token()`, which
 * requires the cookie they already hold. A durable public view of an order is
 * phase 11's tracking page, which is scoped to an order number plus a phone.
 */
create or replace function public.order_receipt(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',            o.id,
    'orderNumber',   o.order_number,
    'placedAt',      o.placed_at,
    'contactName',   o.contact_name,
    'contactPhone',  o.contact_phone,
    'address',       o.shipping_address,
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'status',        o.fulfillment_status,
    'subtotal',      o.subtotal_centavos,
    'discountTotal', o.discount_total_centavos,
    'shippingTotal', o.shipping_total_centavos,
    'codFee',        o.cod_fee_centavos,
    'grandTotal',    o.grand_total_centavos,
    'notes',         o.notes,
    'store', jsonb_build_object('name', t.name, 'slug', t.slug),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'productName',  oi.product_name,
               'variantLabel', oi.variant_label,
               'sku',          oi.sku,
               'qty',          oi.qty,
               'unitPrice',    oi.unit_price_centavos,
               'lineTotal',    oi.line_total_centavos)
             order by oi.created_at, oi.id)
      from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
    join public.tenants t on t.id = o.tenant_id
  where o.id = p_order_id;
$$;

/** The receipt for whoever holds the cart token that produced the order. */
create or replace function public.order_receipt_for_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_order_id uuid;
begin
  select o.id into v_order_id
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where c.token = p_token
  limit 1;

  if v_order_id is null then
    return null;
  end if;
  return public.order_receipt(v_order_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.customers            enable row level security;
alter table public.carts                enable row level security;
alter table public.cart_items           enable row level security;
alter table public.order_counters       enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;

alter table public.customers            force row level security;
alter table public.carts                force row level security;
alter table public.cart_items           force row level security;
alter table public.order_counters       force row level security;
alter table public.orders               force row level security;
alter table public.order_items          force row level security;
alter table public.order_status_history force row level security;

-- customers ----------------------------------------------------------------
create policy "Members read customers" on public.customers for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write customers" on public.customers for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update customers" on public.customers for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Admins delete customers" on public.customers for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- carts --------------------------------------------------------------------
create policy "Members read carts" on public.carts for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff update carts" on public.carts for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Admins delete carts" on public.carts for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

create policy "Members read cart items" on public.cart_items for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write cart items" on public.cart_items for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update cart items" on public.cart_items for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete cart items" on public.cart_items for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

-- orders -------------------------------------------------------------------
create policy "Members read orders" on public.orders for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write orders" on public.orders for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update orders" on public.orders for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
-- No delete policy on purpose. An order is a financial record; phase 9 cancels
-- with a status and a reason instead of removing the row.

create policy "Members read order items" on public.order_items for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write order items" on public.order_items for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update order items" on public.order_items for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));

create policy "Members read order history" on public.order_status_history for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff append order history" on public.order_status_history for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
-- Append-only: no update, no delete policy. An audit trail that can be edited is
-- not an audit trail.

create policy "Members read order counter" on public.order_counters for select to authenticated
  using (public.is_tenant_member(tenant_id));
-- Nothing may write the counter directly; next_order_number() owns it.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.customers            to authenticated;
grant select, insert, update, delete on public.cart_items           to authenticated;
grant select, insert, update         on public.orders               to authenticated;
grant select, insert, update         on public.order_items          to authenticated;
grant select, insert                 on public.order_status_history to authenticated;
grant select                         on public.order_counters       to authenticated;

-- Column-level on carts, because `token` is a bearer credential. A seller has no
-- use for it and handing it over would let them act as the buyer; RLS is
-- row-level, so the column list is the only way to say this.
grant select (id, tenant_id, customer_id, status, source, expires_at, created_at, updated_at)
  on public.carts to authenticated;
grant update (status, customer_id) on public.carts to authenticated;
grant delete on public.carts to authenticated;

-- anon gets NO table access whatsoever — only these functions, each of which
-- authorises with the cart token first.
grant execute on function public.cart_create(text, text)                             to anon, authenticated;
grant execute on function public.cart_view(text, text)                                to anon, authenticated;
grant execute on function public.cart_add_item(text, uuid, int)                       to anon, authenticated;
grant execute on function public.cart_set_qty(text, uuid, int)                        to anon, authenticated;
grant execute on function public.order_receipt_for_token(text)                        to anon, authenticated;
grant execute on function public.checkout_place_order(text, text, text, jsonb, text, text, text)
  to anon, authenticated;

-- Internal. cart_pricing and order_receipt are called by the functions above and
-- by seller-side code; cart_id_for_token resolves a credential. None of them
-- authorise on their own, so none are reachable directly.
revoke all on function public.cart_pricing(uuid, text)      from public, anon, authenticated;
revoke all on function public.cart_id_for_token(text)       from public, anon, authenticated;
revoke all on function public.order_receipt(uuid)           from public, anon;
revoke all on function public.next_order_number(uuid)       from public, anon, authenticated;
grant execute on function public.order_receipt(uuid)        to authenticated;
