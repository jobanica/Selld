-- Phase 4 — inventory.
--
-- THE DESIGN DECISION: the movement ledger is the source of truth, and
-- `inventory_levels.on_hand` is a cache maintained by trigger.
--
-- The alternative — update on_hand and separately write a movement row — drifts.
-- Not hypothetically: one forgotten movement insert, one direct UPDATE from the SQL
-- editor, and the number on screen no longer matches the history that explains it.
-- A seller who cannot reconcile "I have 7" against "here is why" stops trusting the
-- stock figure, and then stops using the inventory feature at all.
--
-- So `on_hand` is never written directly. Insert a movement; the trigger applies the
-- delta. `sum(stock_movements.delta) = inventory_levels.on_hand` is then true by
-- construction, and the isolation suite asserts it.
--
-- RESERVATIONS ARE NOT MOVEMENTS. Reserving changes no physical stock, so it touches
-- `reserved` only. The pair (on_hand, reserved) gives available = on_hand - reserved,
-- and the CHECK constraint `reserved <= on_hand` is what makes overselling
-- impossible at the storage layer rather than in application logic.

-- ---------------------------------------------------------------------------
-- Prerequisite: locations needs a composite key to be referenced
-- ---------------------------------------------------------------------------
-- `locations` shipped in phase 2 without `unique (tenant_id, id)`, so the composite
-- foreign keys below cannot reference it. Added here rather than by editing the
-- phase 2 migration, which is already pushed — migrations are append-only.
alter table public.locations
  add constraint locations_tenant_id_key unique (tenant_id, id);

-- ---------------------------------------------------------------------------
-- inventory_levels
-- ---------------------------------------------------------------------------
create table public.inventory_levels (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  variant_id          uuid not null,
  location_id         uuid not null,

  -- Physically present. Maintained ONLY by apply_stock_movement().
  on_hand             int not null default 0 check (on_hand >= 0),
  -- Committed to orders not yet shipped.
  reserved            int not null default 0 check (reserved >= 0),
  -- On order from a supplier. Informational; does not affect availability.
  incoming            int not null default 0 check (incoming >= 0),

  -- Null means "use the tenant default"; 0 means "never warn me".
  low_stock_threshold int check (low_stock_threshold is null or low_stock_threshold >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (tenant_id, id),
  unique (variant_id, location_id),

  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete cascade,
  foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade,

  -- ***** OVERSELL PREVENTION *****
  -- You cannot promise more than you hold. Every path that would oversell — a
  -- race between two checkouts, a shrinkage adjustment below what is already
  -- committed, a bad manual edit — fails here, in the database, whatever the
  -- application believed.
  constraint inventory_no_oversell check (reserved <= on_hand)
);

create index inventory_levels_variant_idx on public.inventory_levels (variant_id);
create index inventory_levels_location_idx on public.inventory_levels (location_id);
create index inventory_levels_tenant_idx on public.inventory_levels (tenant_id);

-- Low-stock queries scan this constantly on the dashboard.
create index inventory_levels_low_stock_idx
  on public.inventory_levels (tenant_id)
  where low_stock_threshold is not null;

create trigger inventory_levels_set_updated_at
  before update on public.inventory_levels
  for each row execute function public.set_updated_at();

comment on table public.inventory_levels is
  'Stock per variant per location. on_hand is a trigger-maintained cache of the movement ledger — never write it directly.';
comment on column public.inventory_levels.on_hand is
  'Maintained by apply_stock_movement(). Direct writes are rejected by a trigger.';

-- Available to sell. A generated column would need an index for filtering, and
-- this is cheap enough to compute in the view below.
create or replace function public.available_stock(p_on_hand int, p_reserved int)
returns int
language sql
immutable
parallel safe
as $$ select greatest(p_on_hand - p_reserved, 0) $$;

-- ---------------------------------------------------------------------------
-- stock_movements — the ledger
-- ---------------------------------------------------------------------------
create table public.stock_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  variant_id     uuid not null,
  location_id    uuid not null,

  -- Signed. Negative removes stock. Zero is meaningless and rejected.
  delta          int not null check (delta <> 0),

  -- `receive` is not in the build spec's list, but "I bought 100 more" and "I
  -- recounted and found 3 fewer" are different facts and a ledger that cannot tell
  -- them apart cannot explain a discrepancy later.
  reason         text not null check (reason in (
                   'sale', 'return', 'adjustment', 'transfer', 'rts', 'damage', 'receive'
                 )),

  -- What caused it: 'order', 'shipment', 'manual', 'import'…
  reference_type text,
  reference_id   uuid,
  note           text,

  -- Null when the row was written by a system path rather than a person.
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete cascade,
  foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete cascade,
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);

-- The ledger view per variant, newest first — the phase-4 "movement ledger".
create index stock_movements_variant_idx
  on public.stock_movements (variant_id, created_at desc);
create index stock_movements_tenant_idx on public.stock_movements (tenant_id, created_at desc);
create index stock_movements_reference_idx
  on public.stock_movements (reference_type, reference_id)
  where reference_id is not null;

comment on table public.stock_movements is
  'Append-only stock ledger. Source of truth for on_hand; a trigger applies each delta.';

-- ---------------------------------------------------------------------------
-- The trigger that maintains on_hand
-- ---------------------------------------------------------------------------
-- Maintains on_hand from the ledger.
--
-- `selld.applying_movement` is how this function passes the guard trigger below
-- that otherwise rejects any direct write to on_hand. Transaction-scoped
-- (is_local = true), so it cannot leak into another statement.
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Create the level row on first movement, so a seller never has to "initialise
  -- inventory" before receiving stock.
  insert into public.inventory_levels (tenant_id, variant_id, location_id, on_hand)
  values (new.tenant_id, new.variant_id, new.location_id, 0)
  on conflict (variant_id, location_id) do nothing;

  perform set_config('selld.applying_movement', 'on', true);

  -- Read-modify-write in ONE statement, so two concurrent movements cannot both
  -- compute from the same starting value. The check constraints (on_hand >= 0 and
  -- reserved <= on_hand) fire here, atomically with the ledger row.
  update public.inventory_levels
     set on_hand = on_hand + new.delta
   where variant_id = new.variant_id
     and location_id = new.location_id;

  perform set_config('selld.applying_movement', 'off', true);

  return new;
end;
$$;

create trigger stock_movements_apply
  after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- The ledger is append-only. Editing history would break the invariant that
-- on_hand equals the sum of movements — correct a mistake with a compensating
-- movement instead, which is also what an auditor expects to see.
create or replace function public.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'stock_movements is append-only. Write a compensating movement instead of editing history.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger stock_movements_no_update
  before update or delete on public.stock_movements
  for each row execute function public.reject_ledger_mutation();

-- Guard the cache: on_hand may only change via apply_stock_movement().
create or replace function public.reject_direct_on_hand_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.on_hand <> old.on_hand
     and coalesce(current_setting('selld.applying_movement', true), '') <> 'on'
  then
    raise exception
      'on_hand is derived from stock_movements. Insert a movement instead of updating it.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function public.reject_direct_on_hand_write() is
  'Keeps on_hand derivable from the ledger. apply_stock_movement() sets selld.applying_movement to pass.';

create trigger inventory_levels_guard_on_hand
  before update on public.inventory_levels
  for each row execute function public.reject_direct_on_hand_write();

-- ---------------------------------------------------------------------------
-- Reservation API
-- ---------------------------------------------------------------------------

/*
 * Reserve stock for an order.
 *
 * OVERSELL PREVENTION, both halves:
 *
 * 1. **Advisory locks**, taken on every variant in the request, SORTED. Sorting is
 *    not cosmetic: two carts holding {A,B} and {B,A} and locking in arrival order
 *    deadlock, and Postgres resolves that by killing one — a failed checkout for a
 *    buyer who did nothing wrong. Sorted acquisition makes the deadlock impossible.
 *
 * 2. **The CHECK constraint** `reserved <= on_hand`, which is the actual guarantee.
 *    The lock makes the failure clean and the error a business one; the constraint
 *    is what makes overselling impossible even if a future code path forgets to
 *    take the lock.
 *
 * Locks are transaction-scoped (pg_advisory_xact_lock), so they release on commit or
 * rollback with no cleanup path to forget.
 */
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
declare
  v_item      record;
  v_variant   uuid;
  v_updated   int;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not a member of this tenant' using errcode = 'insufficient_privilege';
  end if;

  -- Sorted lock acquisition — see the note above about deadlocks.
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
    -- are one atomic statement. Checking first and updating after would leave a
    -- window, however small.
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

/** Release a reservation — order cancelled, or a live-selling claim expired. */
create or replace function public.release_reservation(
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
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not a member of this tenant' using errcode = 'insufficient_privilege';
  end if;

  for v_variant in
    select distinct (value ->> 'variant_id')::uuid
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
    -- greatest(...) rather than a bare subtraction: a double-release must not drive
    -- reserved negative and silently create phantom availability.
    update public.inventory_levels
       set reserved = greatest(reserved - v_item.qty, 0)
     where variant_id = v_item.variant_id
       and location_id = p_location_id
       and tenant_id = p_tenant_id;
  end loop;
end;
$$;

/**
 * Ship a reservation: convert committed stock into a sale.
 *
 * One transaction does both halves — decrement `reserved` and write the negative
 * `sale` movement that decrements `on_hand`. Doing them separately is how you get a
 * parcel out the door with the stock still showing as available.
 */
create or replace function public.ship_reservation(
  p_tenant_id      uuid,
  p_location_id    uuid,
  p_items          jsonb,
  p_reference_type text default 'shipment',
  p_reference_id   uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item    record;
  v_variant uuid;
begin
  if not public.has_tenant_role(p_tenant_id, 'packer') then
    raise exception 'Not allowed to ship for this tenant' using errcode = 'insufficient_privilege';
  end if;

  for v_variant in
    select distinct (value ->> 'variant_id')::uuid
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
    -- Release the reservation FIRST. The movement below reduces on_hand, and the
    -- `reserved <= on_hand` constraint would reject it while the reservation still
    -- stands.
    update public.inventory_levels
       set reserved = greatest(reserved - v_item.qty, 0)
     where variant_id = v_item.variant_id
       and location_id = p_location_id
       and tenant_id = p_tenant_id;

    insert into public.stock_movements
      (tenant_id, variant_id, location_id, delta, reason, reference_type, reference_id, created_by)
    values
      (p_tenant_id, v_item.variant_id, p_location_id, -v_item.qty, 'sale',
       p_reference_type, p_reference_id, auth.uid());
  end loop;
end;
$$;

/**
 * Record a stock change with a reason. This is the adjustment UI's entry point and
 * the only way stock enters the system.
 */
create or replace function public.record_stock_movement(
  p_tenant_id      uuid,
  p_variant_id     uuid,
  p_location_id    uuid,
  p_delta          int,
  p_reason         text,
  p_note           text default null,
  p_reference_type text default 'manual',
  p_reference_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Staff and above: a packer counts stock but does not decide what it is.
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to adjust stock for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_variant_id::text, 0));

  insert into public.stock_movements
    (tenant_id, variant_id, location_id, delta, reason, note, reference_type, reference_id, created_by)
  values
    (p_tenant_id, p_variant_id, p_location_id, p_delta, p_reason, p_note,
     p_reference_type, p_reference_id, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

/**
 * Set absolute stock, as a stock-take does ("I counted 7").
 *
 * Writes the DIFFERENCE as a movement rather than overwriting on_hand, so the
 * ledger still explains the change and the invariant holds.
 */
create or replace function public.set_stock_level(
  p_tenant_id   uuid,
  p_variant_id  uuid,
  p_location_id uuid,
  p_on_hand     int,
  p_note        text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current int;
  v_delta   int;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to adjust stock for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if p_on_hand < 0 then
    raise exception 'Stock cannot be negative' using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_variant_id::text, 0));

  select on_hand into v_current
  from public.inventory_levels
  where variant_id = p_variant_id and location_id = p_location_id;

  v_delta := p_on_hand - coalesce(v_current, 0);
  if v_delta = 0 then
    return;
  end if;

  insert into public.stock_movements
    (tenant_id, variant_id, location_id, delta, reason, note, reference_type, created_by)
  values
    (p_tenant_id, p_variant_id, p_location_id, v_delta, 'adjustment', p_note, 'stock_take',
     auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Stock by variant with everything the dashboard needs, so the list is one query.
create view public.inventory_overview
with (security_invoker = true)
as
select
  il.id,
  il.tenant_id,
  il.variant_id,
  il.location_id,
  l.name                              as location_name,
  v.product_id,
  p.name                              as product_name,
  v.sku,
  v.price_centavos,
  il.on_hand,
  il.reserved,
  il.incoming,
  public.available_stock(il.on_hand, il.reserved) as available,
  il.low_stock_threshold,
  (il.low_stock_threshold is not null
    and public.available_stock(il.on_hand, il.reserved) <= il.low_stock_threshold) as is_low,
  il.updated_at
from public.inventory_levels il
  join public.product_variants v on v.id = il.variant_id
  join public.products p on p.id = v.product_id
  join public.locations l on l.id = il.location_id;

comment on view public.inventory_overview is
  'Stock per variant with product/location names and a computed low-stock flag.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.inventory_levels enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.inventory_levels force row level security;
alter table public.stock_movements  force row level security;

-- Packers must read stock to pick, and must not be able to change it except
-- through the shipping path, which goes via ship_reservation().
create policy "Members read inventory"
  on public.inventory_levels for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Staff set thresholds"
  on public.inventory_levels for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));

-- No insert/delete policy: rows appear with the first movement and disappear with
-- the variant. No direct on_hand write is possible either — the guard trigger
-- rejects it regardless of role.

create policy "Members read the stock ledger"
  on public.stock_movements for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Writes go through record_stock_movement() / ship_reservation(), which are
-- SECURITY DEFINER and do their own role checks. No direct insert policy, so the
-- ledger cannot be written without going through a path that also holds the lock.

grant select, update on public.inventory_levels to authenticated;
grant select          on public.stock_movements  to authenticated;
grant select          on public.inventory_overview to authenticated;

revoke all on public.inventory_levels    from anon;
revoke all on public.stock_movements     from anon;
revoke all on public.inventory_overview  from anon;

grant execute on function public.available_stock(int, int)                      to authenticated, anon;
grant execute on function public.reserve_stock(uuid, uuid, jsonb, text, uuid)    to authenticated;
grant execute on function public.release_reservation(uuid, uuid, jsonb)          to authenticated;
grant execute on function public.ship_reservation(uuid, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.record_stock_movement(uuid, uuid, uuid, int, text, text, text, uuid) to authenticated;
grant execute on function public.set_stock_level(uuid, uuid, uuid, int, text)    to authenticated;

-- ---------------------------------------------------------------------------
-- Storefront availability
-- ---------------------------------------------------------------------------
-- Buyers need to know whether a variant is buyable. Exact counts are deliberately
-- NOT exposed: it tells a competitor the seller's volume, and "2 left" invites
-- scraping. A boolean plus a coarse bucket is what a product page actually needs.
create view public.storefront_availability as
select
  v.id                as variant_id,
  v.product_id,
  v.tenant_id,
  coalesce(sum(public.available_stock(il.on_hand, il.reserved)), 0) > 0 as in_stock,
  case
    when coalesce(sum(public.available_stock(il.on_hand, il.reserved)), 0) = 0 then 'out'
    when coalesce(sum(public.available_stock(il.on_hand, il.reserved)), 0) <= 5 then 'low'
    else 'ok'
  end                 as stock_state
from public.product_variants v
  join public.products p on p.id = v.product_id
  join public.tenants t on t.id = v.tenant_id
  left join public.inventory_levels il on il.variant_id = v.id
where p.status = 'active' and t.status = 'active'
group by v.id, v.product_id, v.tenant_id;

comment on view public.storefront_availability is
  'Buyable yes/no plus a coarse bucket. Exact counts are withheld on purpose.';

grant select on public.storefront_availability to anon, authenticated;
