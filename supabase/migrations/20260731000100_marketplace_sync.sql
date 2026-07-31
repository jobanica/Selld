/**
 * Phase 17 — Marketplace sync.
 *
 * The done-when is a stopwatch: selling the last unit on the Selld storefront
 * zeroes the Shopee listing within 60 seconds. Everything below is shaped by
 * what that sentence actually requires, and by what it forbids.
 *
 * ## One pool of stock, one direction of authority
 *
 * Selld is the source of truth. Stock goes **out** to the marketplace and orders
 * come **in**; neither ever goes the other way. Two-way stock sync reads as the
 * more complete feature and is the trap: two systems both believing they own the
 * last unit is precisely the 11am double-sell in `docs/avatar.md`, and no
 * reconciliation rule fixes it after the fact because both sales are real.
 *
 * ## What gets pushed is *available*, not *on hand*
 *
 * A buyer on the storefront who reaches the confirmation page has not reduced
 * `on_hand` — the parcel has not shipped. They have raised `reserved`. If the
 * push watched `on_hand` it would fire when the parcel goes out the door, hours
 * or days later, and Shopee would happily sell the same unit in between. So the
 * number pushed is `available_stock(on_hand, reserved)` summed across locations,
 * and the trigger below fires on either column changing.
 *
 * ## Coalescing, not debouncing
 *
 * "Debounced sync on every movement" is right about the problem — a bulk stock
 * take is 200 movements and must not be 200 API calls — and a literal debounce is
 * the wrong fix, because resetting a timer on every event means a steady trickle
 * of sales never pushes at all, which is the one failure mode this phase exists
 * to prevent. What is implemented is a *leading-edge coalesce*: the first
 * movement schedules a push a couple of seconds out, later movements inside that
 * window are absorbed into the same pending row, and the pushed figure is read at
 * push time rather than captured at enqueue time. The burst costs one call, and
 * the deadline is measured from the *first* movement, so it cannot slide.
 *
 * ## A mapping is a fact a seller has to supply, and its absence is a queue item
 *
 * A listing with no variant behind it cannot be pushed, and an inbound order for
 * an SKU nobody mapped cannot be fulfilled. Neither is an error to log and drop:
 * both are work for the seller, so both land in `marketplace_issues` where they
 * can be seen and cleared. Silently skipping an unmapped listing is how a store
 * discovers at 11am that Shopee has been selling from a listing Selld stopped
 * counting three weeks ago.
 */

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------
/**
 * One connected shop.
 *
 * Credentials follow the `courier_accounts` scheme exactly — `pgp_sym_encrypt`
 * with the key held in the server's environment and passed per call — rather
 * than phase 8's plain-column-with-no-grant. A marketplace access token can
 * list, reprice and cancel on the seller's behalf, which puts it in the same
 * class as a courier's API key and a page access token, so it gets the same
 * treatment: a stolen database dump is not enough.
 *
 * `sync_stock` and `sync_orders` are separate switches because sellers genuinely
 * want them separately. Pushing stock while still fulfilling inside Shopee's own
 * dashboard is a coherent, common first step, and forcing both at once is how a
 * cautious seller ends up enabling neither.
 */
create table public.marketplace_connections (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  platform  text not null check (platform in ('shopee', 'lazada', 'tiktok')),

  /** The marketplace's own shop identifier. Not a secret; shown on the screen. */
  shop_id   text not null,
  shop_name text,

  credentials_encrypted bytea,
  /**
   * When the access token stops working. Marketplace tokens are short-lived —
   * Shopee's is four hours — so this is not decoration: the worker refreshes
   * ahead of it rather than discovering expiry as a failed push.
   */
  token_expires_at timestamptz,

  sync_stock  boolean not null default false,
  sync_orders boolean not null default false,

  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'expired', 'error')),
  last_stock_push_at timestamptz,
  last_order_pull_at timestamptz,
  last_error text,

  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  unique (tenant_id, platform, shop_id),
  -- Denormalised `tenant_id` on the children points at this, so a cross-tenant
  -- child is unrepresentable rather than merely forbidden.
  unique (tenant_id, id),

  -- Sync cannot be switched on half-configured. Finding out at push time means a
  -- queue full of failures instead of one clear sentence on a settings screen.
  constraint marketplace_connections_sync_needs_credentials check (
    not (sync_stock or sync_orders) or credentials_encrypted is not null
  )
);

create index marketplace_connections_tenant_idx on public.marketplace_connections (tenant_id);

create trigger marketplace_connections_set_updated_at
  before update on public.marketplace_connections
  for each row execute function public.set_updated_at();

/**
 * What a seller may see about their own connection.
 *
 * Owner-run with `is_tenant_member()` in the WHERE, not `security_invoker` — the
 * same correction `payment_accounts_safe` and `courier_accounts_safe` needed, for
 * the same reason: a view whose job is to derive a fact from a column nobody may
 * read cannot run with the reader's privileges.
 */
create view public.marketplace_connections_safe as
select
  c.id,
  c.tenant_id,
  c.platform,
  c.shop_id,
  c.shop_name,
  c.sync_stock,
  c.sync_orders,
  c.status,
  c.last_stock_push_at,
  c.last_order_pull_at,
  c.last_error,
  c.connected_at,
  c.credentials_encrypted is not null as has_credentials,
  (c.token_expires_at is not null and c.token_expires_at <= now()) as token_expired,
  c.created_at,
  c.updated_at
from public.marketplace_connections c
where public.is_tenant_member(c.tenant_id);

-- ---------------------------------------------------------------------------
-- The mapping
-- ---------------------------------------------------------------------------
/**
 * One marketplace listing, and the Selld variant behind it — if a seller has
 * said which.
 *
 * `variant_id` is nullable on purpose. An unmapped listing is a real state that
 * exists the moment a shop is connected, not an error: the seller has thirty
 * listings and has mapped none of them yet. What must never happen is a listing
 * *silently* staying unmapped, so the mapping screen and `marketplace_issues`
 * both surface it.
 *
 * Two unique constraints, and they say different things:
 *
 *   - one row per listing on a connection — `nulls not distinct`, because a
 *     product with no variations has a null variation id and two of those are
 *     the *same* listing, not two listings. The default NULL-distinct behaviour
 *     would let the same item be inserted repeatedly by a re-import.
 *   - one listing per variant on a connection — two listings pointing at one
 *     variant means each sale halves a number that is shared, and the last unit
 *     gets sold twice. That is a conflict the seller must resolve, so it is
 *     refused at the constraint rather than reconciled later.
 */
create table public.marketplace_listings (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,

  external_item_id      text not null,
  external_variation_id text,
  external_sku          text,
  name  text,
  price_centavos public.centavos,

  variant_id uuid,

  /** What we last told the marketplace, and when. */
  last_pushed_stock int,
  last_pushed_at    timestamptz,
  /** What the marketplace said it had, at the last listing import. */
  external_stock int,

  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  unique (tenant_id, id),

  foreign key (tenant_id, connection_id)
    references public.marketplace_connections (tenant_id, id) on delete cascade,
  -- `set null (variant_id)`, not a bare `set null`: a composite FK's plain
  -- SET NULL nulls *every* column in the key, including the NOT NULL tenant_id,
  -- and the delete raises instead of cascading. Sixteen constraints shipped that
  -- way in phase 12.
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete set null (variant_id),

  unique nulls not distinct (connection_id, external_item_id, external_variation_id)
);

create index marketplace_listings_tenant_idx     on public.marketplace_listings (tenant_id);
create index marketplace_listings_connection_idx on public.marketplace_listings (connection_id);
create index marketplace_listings_variant_idx    on public.marketplace_listings (variant_id)
  where variant_id is not null;

create unique index marketplace_listings_one_per_variant_idx
  on public.marketplace_listings (connection_id, variant_id)
  where variant_id is not null;

create trigger marketplace_listings_set_updated_at
  before update on public.marketplace_listings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The push queue
-- ---------------------------------------------------------------------------
/**
 * One pending stock push per listing.
 *
 * `unique (listing_id)` is the coalescing: a burst of movements produces one row,
 * and `due_at` is set by whichever movement created it and never pushed out by a
 * later one. That is the difference between this and a debounce, and it is the
 * whole reason the 60-second deadline is meetable — a debounce measures from the
 * *last* event in a burst, so a store taking a sale every second would never
 * push while it was busy, which is exactly when it matters most.
 *
 * No `qty` column. The number to send is read from `inventory_levels` at push
 * time, so a row that has been sitting in the queue for two seconds while three
 * more sales landed still sends the truth rather than a stale snapshot.
 */
create table public.marketplace_stock_queue (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  listing_id uuid not null,

  due_at     timestamptz not null default now(),
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),

  primary key (id),
  unique (listing_id),
  foreign key (tenant_id, listing_id)
    references public.marketplace_listings (tenant_id, id) on delete cascade
);

create index marketplace_stock_queue_due_idx on public.marketplace_stock_queue (due_at);

-- ---------------------------------------------------------------------------
-- Logs and the seller's queue
-- ---------------------------------------------------------------------------
/** Every sync attempt, in both directions. */
create table public.marketplace_sync_logs (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid,
  direction text not null check (direction in ('out', 'in')),
  entity    text not null check (entity in ('stock', 'order', 'listing', 'token')),
  status    text not null check (status in ('ok', 'failed', 'skipped')),
  reference text,
  payload   jsonb,
  error     text,
  created_at timestamptz not null default now(),

  primary key (id),
  foreign key (tenant_id, connection_id)
    references public.marketplace_connections (tenant_id, id) on delete cascade
);

create index marketplace_sync_logs_tenant_idx on public.marketplace_sync_logs (tenant_id, created_at desc);

/**
 * The conflict and mapping-error queue.
 *
 * Four kinds, and every one of them is work only the seller can do:
 *
 *   `unmapped_listing`  a listing on the marketplace with no Selld variant, so
 *                       its stock is not being kept in step
 *   `unmapped_sku`      an order arrived for an SKU we cannot resolve — the
 *                       order is still created, because a parcel a buyer paid
 *                       for has to be packed whatever our mapping says
 *   `push_rejected`     the marketplace refused a stock update, repeatedly
 *   `order_conflict`    an inbound order we cannot reconcile with one we hold
 *
 * `unique nulls not distinct (tenant_id, kind, reference)` where unresolved, so
 * a listing that fails to push every two seconds produces one row a seller can
 * act on rather than a wall of identical ones.
 */
create table public.marketplace_issues (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid,
  listing_id    uuid,

  kind text not null
    check (kind in ('unmapped_listing', 'unmapped_sku', 'push_rejected', 'order_conflict')),
  /** What it is about: an external SKU, an order id, a listing id. */
  reference text,
  detail    jsonb,
  message   text,

  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  primary key (id),
  foreign key (tenant_id, connection_id)
    references public.marketplace_connections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, listing_id)
    references public.marketplace_listings (tenant_id, id) on delete set null (listing_id)
);

create index marketplace_issues_tenant_idx on public.marketplace_issues (tenant_id, created_at desc);

create unique index marketplace_issues_open_idx
  on public.marketplace_issues (tenant_id, kind, reference)
  nulls not distinct
  where resolved_at is null;

create trigger marketplace_issues_set_updated_at
  before update on public.marketplace_issues
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Credentials
-- ---------------------------------------------------------------------------
/**
 * Store and read credentials, encrypted. Service role only: the key is the
 * server's, and a function that accepts a key must never be reachable from a
 * browser.
 */
create or replace function public.set_marketplace_credentials(
  p_connection_id uuid,
  p_credentials   jsonb,
  p_key           text,
  p_expires_at    timestamptz default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.marketplace_connections
     set credentials_encrypted = extensions.pgp_sym_encrypt(p_credentials::text, p_key),
         token_expires_at = p_expires_at,
         status = 'connected',
         connected_at = coalesce(connected_at, now()),
         last_error = null
   where id = p_connection_id;
$$;

create or replace function public.marketplace_credentials(
  p_connection_id uuid,
  p_key           text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.credentials_encrypted is null then null
    else extensions.pgp_sym_decrypt(c.credentials_encrypted, p_key)::jsonb
  end
  from public.marketplace_connections c
  where c.id = p_connection_id;
$$;

-- ---------------------------------------------------------------------------
-- What to push
-- ---------------------------------------------------------------------------
/**
 * The number the marketplace should see for one variant.
 *
 * Summed across locations, because a marketplace listing has no concept of one,
 * and floored at zero — a negative is not a number any marketplace accepts, and
 * some of them clamp it silently, which turns an accounting oddity here into an
 * overselling listing there.
 *
 * `available`, not `on_hand`: see the header. A unit that is reserved for a
 * confirmed storefront order is sold, whatever the shelf still looks like.
 */
create or replace function public.marketplace_sellable(p_variant_id uuid)
returns int
language sql
stable
set search_path = ''
as $$
  select greatest(
    coalesce(sum(public.available_stock(il.on_hand, il.reserved)), 0), 0)::int
  from public.inventory_levels il
  where il.variant_id = p_variant_id;
$$;

/**
 * Enqueue a push when a variant's sellable number could have changed.
 *
 * On `inventory_levels`, not on `stock_movements`, because `reserved` moves
 * without a movement row — a checkout reserves, and that is exactly the event
 * the done-when is about.
 *
 * `on conflict do nothing` is the coalesce. The row that is already pending
 * keeps its `due_at`, so the deadline runs from the first movement of a burst.
 */
create or replace function public.marketplace_enqueue_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_debounce interval := interval '2 seconds';
begin
  -- `clock_timestamp()`, not `now()`. `now()` is the *transaction* timestamp, so
  -- every movement inside one transaction schedules the same instant — which
  -- makes a real debounce and this coalesce indistinguishable from the outside,
  -- and hid the difference from the sabotage test that exists to tell them
  -- apart. It is also simply more accurate: a checkout that takes half a second
  -- would otherwise schedule its push half a second in the past.
  insert into public.marketplace_stock_queue (tenant_id, listing_id, due_at)
  select l.tenant_id, l.id, clock_timestamp() + v_debounce
  from public.marketplace_listings l
    join public.marketplace_connections c
      on c.id = l.connection_id and c.tenant_id = l.tenant_id
  where l.variant_id = new.variant_id
    and l.is_active
    and c.sync_stock
    and c.status = 'connected'
  on conflict (listing_id) do nothing;

  return new;
end;
$$;

create trigger inventory_levels_marketplace_push
  after insert or update of on_hand, reserved on public.inventory_levels
  for each row execute function public.marketplace_enqueue_stock();

/**
 * Claim the next batch of due pushes.
 *
 * `for update skip locked` so two workers can drain the queue without pushing
 * the same listing twice, and the rows are *deleted* on claim rather than marked
 * — a push that fails is re-enqueued by `marketplace_push_record` with a backoff,
 * and leaving a claimed row behind is how a crashed worker blocks a listing
 * forever.
 *
 * The stock figure is read here, at claim time, not at enqueue time.
 */
create or replace function public.marketplace_push_claim(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  with claimed as (
    select q.id, q.listing_id, q.tenant_id, q.attempts
    from public.marketplace_stock_queue q
    where q.due_at <= now()
    order by q.due_at
    for update skip locked
    limit greatest(coalesce(p_limit, 50), 1)
  ),
  removed as (
    delete from public.marketplace_stock_queue q
    using claimed
    where q.id = claimed.id
    returning q.listing_id, q.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'listingId',           l.id,
    'tenantId',            l.tenant_id,
    'connectionId',        l.connection_id,
    'platform',            c.platform,
    'shopId',              c.shop_id,
    'externalItemId',      l.external_item_id,
    'externalVariationId', l.external_variation_id,
    'externalSku',         l.external_sku,
    'variantId',           l.variant_id,
    'attempts',            removed.attempts,
    -- Null variant means nobody has mapped this listing. It is claimed and
    -- reported so the caller can raise the issue, rather than left in the queue
    -- to be claimed again in two seconds forever.
    'onHand', case when l.variant_id is null then null
                   else public.marketplace_sellable(l.variant_id) end)), '[]'::jsonb)
  into v_rows
  from removed
    join public.marketplace_listings l on l.id = removed.listing_id
    join public.marketplace_connections c on c.id = l.connection_id;

  return v_rows;
end;
$$;

/**
 * Record what the marketplace said.
 *
 * A failure is re-enqueued with an exponential backoff and, once it has clearly
 * stopped being transient, raised as an issue the seller can see — because a
 * listing that has silently refused every update for a day is a listing that is
 * overselling, and nothing else in the product would ever mention it.
 */
create or replace function public.marketplace_push_record(
  p_listing_id uuid,
  p_status     text,
  p_stock      int default null,
  p_error      text default null,
  p_attempts   int default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l record;
  v_next int := coalesce(p_attempts, 0) + 1;
begin
  select l.*, c.platform into v_l
  from public.marketplace_listings l
    join public.marketplace_connections c on c.id = l.connection_id
  where l.id = p_listing_id;
  if v_l.id is null then return; end if;

  insert into public.marketplace_sync_logs
    (tenant_id, connection_id, direction, entity, status, reference, payload, error)
  values (v_l.tenant_id, v_l.connection_id, 'out', 'stock',
          case when p_status = 'ok' then 'ok'
               when p_status = 'skipped' then 'skipped'
               else 'failed' end,
          v_l.external_sku,
          jsonb_build_object('itemId', v_l.external_item_id,
                             'variationId', v_l.external_variation_id,
                             'stock', p_stock),
          p_error);

  if p_status = 'ok' then
    update public.marketplace_listings
       set last_pushed_stock = p_stock, last_pushed_at = now()
     where id = p_listing_id;

    update public.marketplace_connections
       set last_stock_push_at = now(), last_error = null
     where id = v_l.connection_id;

    -- The listing works again, so close whatever was said about it.
    update public.marketplace_issues
       set resolved_at = now()
     where tenant_id = v_l.tenant_id
       and kind = 'push_rejected'
       and reference = p_listing_id::text
       and resolved_at is null;
    return;
  end if;

  if p_status = 'unmapped' then
    insert into public.marketplace_issues
      (tenant_id, connection_id, listing_id, kind, reference, message, detail)
    values (v_l.tenant_id, v_l.connection_id, p_listing_id, 'unmapped_listing',
            p_listing_id::text,
            'This listing is not linked to a product, so its stock is not being kept in step.',
            jsonb_build_object('sku', v_l.external_sku, 'name', v_l.name))
    on conflict (tenant_id, kind, reference) where resolved_at is null do nothing;
    return;
  end if;

  -- Failed. Back off: 4s, 8s, 16s … capped at five minutes, and give up
  -- re-queueing after six tries so a dead listing does not spin forever.
  if v_next <= 6 then
    insert into public.marketplace_stock_queue (tenant_id, listing_id, due_at, attempts, last_error)
    values (v_l.tenant_id, p_listing_id,
            now() + least(power(2, v_next + 1) * interval '1 second', interval '5 minutes'),
            v_next, p_error)
    on conflict (listing_id) do update
      set attempts = excluded.attempts, last_error = excluded.last_error;
  end if;

  update public.marketplace_connections
     set last_error = p_error, status = case when v_next > 6 then 'error' else status end
   where id = v_l.connection_id;

  if v_next >= 3 then
    insert into public.marketplace_issues
      (tenant_id, connection_id, listing_id, kind, reference, message, detail)
    values (v_l.tenant_id, v_l.connection_id, p_listing_id, 'push_rejected',
            p_listing_id::text,
            'The marketplace has refused this stock update repeatedly.',
            jsonb_build_object('sku', v_l.external_sku, 'error', p_error,
                               'attempts', v_next))
    on conflict (tenant_id, kind, reference) where resolved_at is null do update
      set detail = excluded.detail, updated_at = now();
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Listings, in
-- ---------------------------------------------------------------------------
/**
 * Import the listings a shop has, and auto-match what can be matched.
 *
 * Matching is on SKU and only on SKU. Matching on *name* is the tempting extra
 * mile and is wrong: "Rosehip Serum 30ml" and "Rosehip Serum 30 ml" are the same
 * product to a human and two different rows to anything mechanical, and a
 * mis-matched listing pushes one product's stock onto another's listing — which
 * oversells one and hides the other. An SKU is a thing the seller typed on both
 * sides on purpose.
 *
 * `on conflict do update` on everything except `variant_id`: a re-import must not
 * undo a mapping the seller made by hand.
 */
create or replace function public.marketplace_listings_import(
  p_connection_id uuid,
  p_listings      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_imported int := 0;
  v_matched  int := 0;
begin
  select * into v_c from public.marketplace_connections where id = p_connection_id;
  if v_c.id is null then
    raise exception 'Connection not found' using errcode = 'no_data_found';
  end if;

  insert into public.marketplace_listings
    (tenant_id, connection_id, external_item_id, external_variation_id,
     external_sku, name, price_centavos, external_stock, is_active)
  select
    v_c.tenant_id, v_c.id,
    e ->> 'externalItemId',
    nullif(e ->> 'externalVariationId', ''),
    nullif(e ->> 'externalSku', ''),
    e ->> 'name',
    (e ->> 'price')::bigint,
    (e ->> 'stock')::int,
    true
  from jsonb_array_elements(coalesce(p_listings, '[]'::jsonb)) e
  on conflict (connection_id, external_item_id, external_variation_id) do update
    set external_sku   = excluded.external_sku,
        name           = excluded.name,
        price_centavos = excluded.price_centavos,
        external_stock = excluded.external_stock,
        is_active      = true;

  get diagnostics v_imported = row_count;

  -- Auto-match by SKU, and only where nobody has mapped it already. The
  -- `not exists` keeps the one-listing-per-variant constraint from raising on a
  -- variant that already has a listing on this connection.
  update public.marketplace_listings l
     set variant_id = v.id
  from public.product_variants v
  where l.connection_id = p_connection_id
    and l.variant_id is null
    and l.external_sku is not null
    and v.tenant_id = l.tenant_id
    and upper(btrim(v.sku)) = upper(btrim(l.external_sku))
    and not exists (
      select 1 from public.marketplace_listings other
      where other.connection_id = l.connection_id
        and other.variant_id = v.id);

  get diagnostics v_matched = row_count;

  insert into public.marketplace_sync_logs
    (tenant_id, connection_id, direction, entity, status, payload)
  values (v_c.tenant_id, v_c.id, 'in', 'listing', 'ok',
          jsonb_build_object('imported', v_imported, 'matched', v_matched));

  -- Anything still unmapped is the seller's to decide, so say so once per
  -- listing rather than discovering it at push time.
  insert into public.marketplace_issues
    (tenant_id, connection_id, listing_id, kind, reference, message, detail)
  select v_c.tenant_id, v_c.id, l.id, 'unmapped_listing', l.id::text,
         'This listing is not linked to a product, so its stock is not being kept in step.',
         jsonb_build_object('sku', l.external_sku, 'name', l.name)
  from public.marketplace_listings l
  where l.connection_id = p_connection_id and l.variant_id is null and l.is_active
  on conflict (tenant_id, kind, reference) where resolved_at is null do nothing;

  return jsonb_build_object('imported', v_imported, 'matched', v_matched);
end;
$$;

-- ---------------------------------------------------------------------------
-- Orders, in
-- ---------------------------------------------------------------------------
/**
 * The idempotency `marketplace_order_ingest` depends on.
 *
 * `orders.channel_ref` has existed since phase 6 to hold "the marketplace order
 * id" and nothing has ever written it, so nothing has ever needed it to be
 * unique. It does now: a pull is repeated by design — the worker asks "anything
 * since 09:00" every few minutes and the same order comes back until the cursor
 * passes it — and a `select ... if not found ... insert` is a read-then-write
 * race that two workers, or one worker and a retry, lose by creating the parcel
 * twice.
 *
 * Partial, because every storefront order has a null `channel_ref` and NULLs
 * would otherwise be the only thing keeping them from colliding.
 */
create unique index orders_channel_ref_idx
  on public.orders (tenant_id, channel_ref)
  where channel_ref is not null;


/**
 * Take one marketplace order and make it a Selld order.
 *
 * Two properties matter more than anything else here.
 *
 * **Idempotent.** A pull is by definition repeated — the worker asks "anything
 * since 09:00" every few minutes and the same order comes back until its
 * timestamp is behind the cursor. `orders.channel_ref` holds the marketplace's
 * own order id and `(tenant_id, channel_ref)` is unique, so a second ingest is a
 * no-op that returns the order it already made.
 *
 * **It does not reserve stock.** The unit is already gone — the marketplace sold
 * it, from a number we pushed. Reserving here would double-count it against the
 * storefront and, at the end of a run, show negative availability. What it does
 * instead is record a movement of `-qty` with reason `sale`, so `on_hand` follows
 * reality and the next push tells the *other* marketplaces about it. That is the
 * cross-channel half of "one pool of stock", and it is why the movement is
 * written even when the SKU cannot be mapped is *not* true: an unmapped SKU has
 * no variant to move, which is exactly why it becomes an issue.
 *
 * The order is still created when an SKU is unmapped. A buyer has paid and a
 * parcel has to be packed; refusing the order because our mapping is incomplete
 * would hide it from the one screen the packer looks at.
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
     cod_fee_centavos, grand_total_centavos,
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
-- Seller-facing
-- ---------------------------------------------------------------------------
/** Connect a shop. The credentials arrive separately, from the server. */
create or replace function public.marketplace_connect(
  p_tenant_id uuid,
  p_platform  text,
  p_shop_id   text,
  p_shop_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.marketplace_connections (tenant_id, platform, shop_id, shop_name)
  values (p_tenant_id, p_platform, p_shop_id, p_shop_name)
  on conflict (tenant_id, platform, shop_id) do update
    set shop_name = coalesce(excluded.shop_name, public.marketplace_connections.shop_name)
  returning id into v_id;

  return v_id;
end;
$$;

/** Turn stock or order sync on and off. */
create or replace function public.marketplace_set_sync(
  p_connection_id uuid,
  p_sync_stock    boolean default null,
  p_sync_orders   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_c record;
begin
  select * into v_c from public.marketplace_connections where id = p_connection_id;
  if v_c.id is null then
    raise exception 'Connection not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_c.tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  update public.marketplace_connections
     set sync_stock  = coalesce(p_sync_stock, sync_stock),
         sync_orders = coalesce(p_sync_orders, sync_orders)
   where id = p_connection_id;

  -- Switching stock sync on is a promise that the marketplace is about to be
  -- told the truth, so make it true now rather than at the next sale.
  if coalesce(p_sync_stock, false) then
    insert into public.marketplace_stock_queue (tenant_id, listing_id, due_at)
    select l.tenant_id, l.id, now()
    from public.marketplace_listings l
    where l.connection_id = p_connection_id and l.is_active
    on conflict (listing_id) do nothing;
  end if;

  return jsonb_build_object('syncStock', (select sync_stock from public.marketplace_connections where id = p_connection_id),
                            'syncOrders', (select sync_orders from public.marketplace_connections where id = p_connection_id));
end;
$$;

/** Map one listing to a variant, or unmap it. */
create or replace function public.marketplace_map_listing(
  p_listing_id uuid,
  p_variant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_l record;
begin
  select * into v_l from public.marketplace_listings where id = p_listing_id;
  if v_l.id is null then
    raise exception 'Listing not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_l.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.product_variants v
    where v.id = p_variant_id and v.tenant_id = v_l.tenant_id) then
    raise exception 'That product is not in this store' using errcode = 'foreign_key_violation';
  end if;

  -- The unique index below would catch this anyway, as a 23505 naming an index.
  -- A seller tapping "link this to Rosehip 30ml" is owed the reason instead: the
  -- other listing is already pushing that variant's number, and pointing a second
  -- one at it is how the last unit gets sold twice.
  if p_variant_id is not null and exists (
    select 1 from public.marketplace_listings other
    where other.connection_id = v_l.connection_id
      and other.variant_id = p_variant_id
      and other.id <> p_listing_id) then
    raise exception 'already_mapped' using
      errcode = 'unique_violation',
      detail = (select coalesce(other.name, other.external_sku, other.external_item_id)
                from public.marketplace_listings other
                where other.connection_id = v_l.connection_id
                  and other.variant_id = p_variant_id
                  and other.id <> p_listing_id
                limit 1);
  end if;

  update public.marketplace_listings set variant_id = p_variant_id where id = p_listing_id;

  if p_variant_id is null then
    -- Unlinking is not a tidy-up, it is a decision with a consequence: from this
    -- moment the listing's stock is no longer kept in step, which is exactly the
    -- state `unmapped_listing` exists to describe. Returning quietly here left a
    -- seller who unlinked something with a clean queue and a listing quietly
    -- overselling.
    insert into public.marketplace_issues
      (tenant_id, connection_id, listing_id, kind, reference, message, detail)
    values (v_l.tenant_id, v_l.connection_id, p_listing_id, 'unmapped_listing',
            p_listing_id::text,
            'This listing is not linked to a product, so its stock is not being kept in step.',
            jsonb_build_object('sku', v_l.external_sku, 'name', v_l.name))
    on conflict (tenant_id, kind, reference) where resolved_at is null do nothing;

    return jsonb_build_object('mapped', false);
  end if;

  -- Mapped, so the issue is answered and the listing owes the marketplace a
  -- number it has never been told.
  update public.marketplace_issues
     set resolved_at = now()
   where tenant_id = v_l.tenant_id and kind = 'unmapped_listing'
     and reference = p_listing_id::text and resolved_at is null;

  insert into public.marketplace_stock_queue (tenant_id, listing_id, due_at)
  values (v_l.tenant_id, p_listing_id, now())
  on conflict (listing_id) do nothing;

  return jsonb_build_object('mapped', true,
                            'stock', public.marketplace_sellable(p_variant_id));
end;
$$;

/** The mapping screen, in one round trip. */
create or replace function public.marketplace_overview(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'platform', c.platform, 'shopId', c.shop_id, 'shopName', c.shop_name,
        'syncStock', c.sync_stock, 'syncOrders', c.sync_orders, 'status', c.status,
        'hasCredentials', c.credentials_encrypted is not null,
        'lastStockPushAt', c.last_stock_push_at, 'lastOrderPullAt', c.last_order_pull_at,
        'lastError', c.last_error,
        'listings', (select count(*)::int from public.marketplace_listings l
                     where l.connection_id = c.id and l.is_active),
        'mapped', (select count(*)::int from public.marketplace_listings l
                   where l.connection_id = c.id and l.is_active and l.variant_id is not null))
        order by c.platform, c.shop_id)
      from public.marketplace_connections c where c.tenant_id = p_tenant_id), '[]'::jsonb),

    'listings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'connectionId', l.connection_id, 'platform', c.platform,
        'externalItemId', l.external_item_id, 'externalSku', l.external_sku,
        'name', l.name, 'price', l.price_centavos,
        'variantId', l.variant_id,
        'variantSku', v.sku,
        'productName', p.name,
        'sellable', case when l.variant_id is null then null
                         else public.marketplace_sellable(l.variant_id) end,
        'lastPushedStock', l.last_pushed_stock, 'lastPushedAt', l.last_pushed_at)
        order by (l.variant_id is not null), l.name)
      from public.marketplace_listings l
        join public.marketplace_connections c on c.id = l.connection_id
        left join public.product_variants v on v.id = l.variant_id
        left join public.products p on p.id = v.product_id
      where l.tenant_id = p_tenant_id and l.is_active), '[]'::jsonb),

    'issues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'reference', i.reference,
        'message', i.message, 'detail', i.detail, 'createdAt', i.created_at)
        order by i.created_at desc)
      from public.marketplace_issues i
      where i.tenant_id = p_tenant_id and i.resolved_at is null), '[]'::jsonb))
  into v_result;

  return v_result;
end;
$$;

/** Clear one queue item. */
create or replace function public.marketplace_issue_resolve(p_issue_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_i record;
begin
  select * into v_i from public.marketplace_issues where id = p_issue_id;
  if v_i.id is null then return; end if;
  if not public.has_tenant_role(v_i.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.marketplace_issues set resolved_at = now() where id = p_issue_id;
end;
$$;

/** Connections the worker should pull orders for. Service role only. */
create or replace function public.marketplace_connections_due()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'tenantId', c.tenant_id, 'platform', c.platform, 'shopId', c.shop_id,
    'since', coalesce(c.last_order_pull_at, now() - interval '1 day'))), '[]'::jsonb)
  from public.marketplace_connections c
  where c.sync_orders and c.status = 'connected' and c.credentials_encrypted is not null;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.marketplace_connections enable row level security;
alter table public.marketplace_connections force  row level security;
alter table public.marketplace_listings    enable row level security;
alter table public.marketplace_listings    force  row level security;
alter table public.marketplace_stock_queue enable row level security;
alter table public.marketplace_stock_queue force  row level security;
alter table public.marketplace_sync_logs   enable row level security;
alter table public.marketplace_sync_logs   force  row level security;
alter table public.marketplace_issues      enable row level security;
alter table public.marketplace_issues      force  row level security;

/**
 * `marketplace_connections` has RLS on and **no policy at all**, the same as
 * `social_accounts`, and for the same reason: the row carries an encrypted
 * access token that can list, reprice and cancel as the seller. There is no
 * SELECT grant either. Everything a seller needs to see comes from
 * `marketplace_connections_safe`, which derives "connected" and "expired"
 * without carrying the secret.
 */

create policy "Members read listings" on public.marketplace_listings
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "Members read sync logs" on public.marketplace_sync_logs
  for select to authenticated using (public.is_tenant_member(tenant_id));

create policy "Members read issues" on public.marketplace_issues
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- `marketplace_stock_queue` has no policy either. It is the worker's scratch
-- space; a seller reading it learns nothing the listing row does not already say.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select on public.marketplace_listings  to authenticated;
grant select on public.marketplace_sync_logs to authenticated;
grant select on public.marketplace_issues    to authenticated;
grant select on public.marketplace_connections_safe to authenticated;

/**
 * `revoke ... from public` first, then grant — Postgres grants EXECUTE on every
 * new function to PUBLIC, so a bare `grant to authenticated` leaves `anon`
 * holding it through PUBLIC and reports no error either way. And the revoke
 * takes it from `service_role` too, which has BYPASSRLS but is not a superuser
 * and still needs grants — so every server-side function is granted back
 * explicitly below.
 */
revoke all on function public.set_marketplace_credentials(uuid, jsonb, text, timestamptz) from public;
revoke all on function public.marketplace_credentials(uuid, text)          from public;
revoke all on function public.marketplace_sellable(uuid)                   from public;
revoke all on function public.marketplace_enqueue_stock()                  from public;
revoke all on function public.marketplace_push_claim(int)                  from public;
revoke all on function public.marketplace_push_record(uuid, text, int, text, int) from public;
revoke all on function public.marketplace_listings_import(uuid, jsonb)     from public;
revoke all on function public.marketplace_order_ingest(uuid, jsonb)        from public;
revoke all on function public.marketplace_connections_due()                from public;
revoke all on function public.marketplace_connect(uuid, text, text, text)  from public;
revoke all on function public.marketplace_set_sync(uuid, boolean, boolean) from public;
revoke all on function public.marketplace_map_listing(uuid, uuid)          from public;
revoke all on function public.marketplace_overview(uuid)                   from public;
revoke all on function public.marketplace_issue_resolve(uuid)              from public;

-- Server-only: these take an encryption key, spend a seller's rate limit, or
-- write orders.
grant execute on function public.set_marketplace_credentials(uuid, jsonb, text, timestamptz) to service_role;
grant execute on function public.marketplace_credentials(uuid, text)          to service_role;
grant execute on function public.marketplace_sellable(uuid)                   to service_role;
grant execute on function public.marketplace_push_claim(int)                  to service_role;
grant execute on function public.marketplace_push_record(uuid, text, int, text, int) to service_role;
grant execute on function public.marketplace_listings_import(uuid, jsonb)     to service_role;
grant execute on function public.marketplace_order_ingest(uuid, jsonb)        to service_role;
grant execute on function public.marketplace_connections_due()                to service_role;

-- Seller-facing: each one checks membership or a role itself, because a
-- SECURITY DEFINER granted to `authenticated` is not tenant-scoped on its own.
grant execute on function public.marketplace_connect(uuid, text, text, text)  to authenticated, service_role;
grant execute on function public.marketplace_set_sync(uuid, boolean, boolean) to authenticated, service_role;
grant execute on function public.marketplace_map_listing(uuid, uuid)          to authenticated, service_role;
grant execute on function public.marketplace_overview(uuid)                   to authenticated, service_role;
grant execute on function public.marketplace_issue_resolve(uuid)              to authenticated, service_role;
