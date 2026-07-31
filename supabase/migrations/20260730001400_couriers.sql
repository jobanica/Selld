/**
 * Phase 10 — Courier integration.
 *
 * The done-when is a stopwatch again: 40 orders booked and one PDF of 40 labels
 * downloaded in under 30 seconds. Booking is the slowest thing Selld does, because
 * unlike every other phase the work is *not* ours — it is 40 HTTP round trips to
 * J&T. So the shape here is about making failure survivable rather than making
 * Postgres fast:
 *
 * - **A booking that fails does not fail the batch.** 40 parcels, one unserviceable
 *   barangay: the other 39 must still get waybills. Failures land in
 *   `courier_booking_failures` with the retry curve, and the seller is told.
 * - **A retry must not create a second parcel.** The idempotency key is derived from
 *   the order, so a retry after a timeout is recognised by the courier as the same
 *   request. Two waybills for one order means two riders, two pickups and one
 *   unhappy buyer.
 * - **The waybill is the source of truth for "shipped".** `record_shipment` moves
 *   the order in the same statement that stores the waybill, so an order can never
 *   be `shipped` with nothing to track.
 *
 * ## Credentials are encrypted at rest, with the key outside the database
 *
 * The spec asks for encrypted credentials, and this is the first place it does.
 * `pgp_sym_encrypt` from pgcrypto, with the key passed in by the server from its
 * environment — never stored in Postgres.
 *
 * That is deliberately not Supabase Vault. Vault is the idiomatic answer and keeps
 * the key material in the same instance, which means a stolen database dump yields
 * the plaintext. Keying from the server's environment makes a dump alone useless,
 * and avoids depending on a `supabase_vault` version that may differ between the
 * local stack and the Postgres image CI runs.
 *
 * The cost, stated plainly: the key transits as a function argument, so an instance
 * with `log_statement = all` would write it to the log. That is a deployment
 * setting, and it is the trade taken here.
 *
 * (Phase 8's `payment_accounts` stores its secrets in plain columns with no SELECT
 * grant. That was what the spec asked for there and it is not *wrong* — no client
 * role can read them — but these two should converge on this scheme. Noted rather
 * than silently changed in a phase that is not about payments.)
 */

-- ---------------------------------------------------------------------------
-- Courier accounts
-- ---------------------------------------------------------------------------
create table public.courier_accounts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  courier    text not null check (courier in ('jnt', 'flash', 'lbc', 'ninja')),

  /**
   * The courier's API credentials, encrypted.
   *
   * A jsonb document (customer code, API key, secret, whatever the courier wants)
   * encrypted as one blob rather than a column per field, because every courier
   * asks for a different set and a schema change per courier is exactly what the
   * provider interface exists to avoid.
   */
  credentials_encrypted bytea,

  /** Where parcels are collected from. Couriers price on origin, not just destination. */
  origin_address jsonb,
  sender_name    text,
  sender_phone   text check (sender_phone is null or sender_phone ~ '^\+63[0-9]{9,10}$'),

  /** The courier's own account/merchant identifier. Not a secret; printed on manifests. */
  account_ref text,
  is_live     boolean not null default false,
  is_enabled  boolean not null default false,
  connected_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (tenant_id, courier),
  -- An account cannot be switched on half-configured: a booking needs credentials
  -- and somewhere to collect from, and finding that out at booking time means 40
  -- failures instead of one clear message on a settings screen.
  constraint courier_accounts_enabled_needs_setup check (
    not is_enabled or (
      credentials_encrypted is not null
      and origin_address is not null
      and sender_name is not null
      and sender_phone is not null
    )
  )
);

create index courier_accounts_tenant_idx on public.courier_accounts (tenant_id);

create trigger courier_accounts_set_updated_at
  before update on public.courier_accounts
  for each row execute function public.set_updated_at();

/**
 * What a seller may see about their own courier connection.
 *
 * Owner-run, not `security_invoker`, and with `is_tenant_member` in the WHERE — the
 * same shape as `payment_accounts_safe`, and for the same reason it was rewritten
 * there: a view whose job is to derive facts from a column nobody may read cannot
 * run with the reader's privileges.
 */
create view public.courier_accounts_safe as
select
  a.id,
  a.tenant_id,
  a.courier,
  a.account_ref,
  a.is_live,
  a.is_enabled,
  a.connected_at,
  a.origin_address,
  a.sender_name,
  a.sender_phone,
  a.credentials_encrypted is not null as has_credentials,
  a.created_at,
  a.updated_at
from public.courier_accounts a
where public.is_tenant_member(a.tenant_id);

/**
 * Store credentials, encrypted.
 *
 * Service-role only: the key is the server's, and a function that accepts a key is
 * a function that must never be reachable from a browser.
 */
create or replace function public.set_courier_credentials(
  p_tenant_id uuid,
  p_courier   text,
  p_credentials jsonb,
  p_key       text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.courier_accounts
     set credentials_encrypted = extensions.pgp_sym_encrypt(p_credentials::text, p_key)
   where tenant_id = p_tenant_id and courier = p_courier;
$$;

/** Read them back. Service role only, for the same reason. */
create or replace function public.courier_credentials(
  p_account_id uuid,
  p_key        text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when a.credentials_encrypted is null then null
    else extensions.pgp_sym_decrypt(a.credentials_encrypted, p_key)::jsonb
  end
  from public.courier_accounts a
  where a.id = p_account_id and a.is_enabled;
$$;

-- ---------------------------------------------------------------------------
-- Shipments
-- ---------------------------------------------------------------------------
/**
 * One booked parcel.
 *
 * `unique (tenant_id, courier, waybill)` because a waybill is the courier's own
 * identifier and a duplicate means we booked twice — which is the failure this
 * phase spends most of its care avoiding.
 *
 * An order can legitimately have more than one shipment: a split consignment, or a
 * re-book after an RTS. So this is a child table, not columns on `orders`.
 */
create table public.shipments (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id  uuid not null,

  courier   text not null check (courier in ('jnt', 'flash', 'lbc', 'ninja')),
  waybill   text not null,
  service   text not null,
  label_url text,

  status text not null default 'booked' check (
    status in ('booked', 'picked_up', 'in_transit', 'out_for_delivery',
               'delivered', 'delivery_failed', 'returning', 'returned',
               'cancelled', 'unknown')
  ),

  cost_centavos public.centavos check (cost_centavos >= 0),
  cod_centavos  public.centavos not null default 0 check (cod_centavos >= 0),
  weight_grams  int check (weight_grams > 0),

  booked_at    timestamptz not null default now(),
  delivered_at timestamptz,
  raw          jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, courier, waybill),

  -- Composite FK, not a trigger: a shipment against another tenant's order becomes
  -- unrepresentable. Phase 9's sabotage run showed this catching a bad WHERE clause
  -- before any policy did.
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade
);

create index shipments_order_idx   on public.shipments (tenant_id, order_id);
create index shipments_waybill_idx on public.shipments (tenant_id, waybill);
create index shipments_status_idx  on public.shipments (tenant_id, status)
  where status not in ('delivered', 'returned', 'cancelled');

create trigger shipments_set_updated_at
  before update on public.shipments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The booking failure queue
-- ---------------------------------------------------------------------------
/**
 * A booking that did not work, and what to do about it.
 *
 * Exists because 40 bookings are 40 chances for someone else's API to be having a
 * bad minute, and the alternative to a queue is a seller re-selecting the failed
 * subset by hand from a list that does not tell them which subset that is.
 *
 * `kind` separates what a retry can fix from what it cannot. An unserviceable
 * barangay will never book, however many times it is tried; a 503 almost certainly
 * will. Retrying the first forever is how a queue becomes noise a seller ignores.
 */
create table public.courier_booking_failures (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id  uuid not null,
  courier   text not null,

  kind text not null check (kind in ('transient', 'permanent', 'auth')),
  error_code    text,
  error_message text not null,

  attempts     int not null default 1 check (attempts >= 1),
  next_retry_at timestamptz,
  resolved_at  timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One open failure per order per courier. A batch retried three times must not
  -- leave three rows for a seller to work through.
  unique (tenant_id, order_id, courier),

  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade
);

create index courier_booking_failures_open_idx
  on public.courier_booking_failures (tenant_id, next_retry_at)
  where resolved_at is null;

create trigger courier_booking_failures_set_updated_at
  before update on public.courier_booking_failures
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Recording a booking
-- ---------------------------------------------------------------------------
/**
 * Store a waybill and move the order, in one statement.
 *
 * The order reaching `shipped` and the waybill existing are the same fact, so they
 * are written together. Splitting them allows an order that says shipped with
 * nothing to track — which is the state a buyer phones about and nobody can answer.
 *
 * Idempotent on `(tenant_id, courier, waybill)`: a retry that the courier answered
 * with the *same* waybill (because the idempotency key worked) updates rather than
 * inserting, so the safety net at the provider is not undone here.
 */
create or replace function public.record_shipment(
  p_tenant_id uuid,
  p_order_id  uuid,
  p_courier   text,
  p_waybill   text,
  p_service   text,
  p_label_url text default null,
  p_cost      bigint default null,
  p_cod       bigint default 0,
  p_weight    int default null,
  p_raw       jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_order  record;
  v_moved  boolean := false;
begin
  select * into v_order from public.orders
   where id = p_order_id and tenant_id = p_tenant_id;
  if v_order.id is null then
    raise exception 'Order not found in this tenant' using errcode = 'no_data_found';
  end if;

  insert into public.shipments
    (tenant_id, order_id, courier, waybill, service, label_url,
     cost_centavos, cod_centavos, weight_grams, raw)
  values (p_tenant_id, p_order_id, p_courier, p_waybill, p_service, p_label_url,
          p_cost, coalesce(p_cod, 0), p_weight, p_raw)
  on conflict (tenant_id, courier, waybill) do update
    set label_url = coalesce(excluded.label_url, public.shipments.label_url),
        raw       = coalesce(excluded.raw, public.shipments.raw)
  returning id into v_id;

  -- Booking is what "shipped" means. Only `packed` may move — an order that is
  -- already shipped or delivered is left alone, so a re-book after an RTS records
  -- the new waybill without rewinding the order's state.
  if v_order.fulfillment_status = 'packed' then
    update public.orders set fulfillment_status = 'shipped' where id = p_order_id;
    insert into public.order_status_history
      (tenant_id, order_id, field, from_status, to_status, note)
    values (p_tenant_id, p_order_id, 'fulfillment_status', 'packed', 'shipped',
            format('%s %s', p_courier, p_waybill));
    v_moved := true;
  end if;

  -- A successful booking closes any open failure for this order.
  update public.courier_booking_failures
     set resolved_at = now()
   where tenant_id = p_tenant_id and order_id = p_order_id
     and courier = p_courier and resolved_at is null;

  return jsonb_build_object(
    'shipmentId', v_id, 'waybill', p_waybill, 'movedToShipped', v_moved);
end;
$$;

/**
 * Record a booking that failed.
 *
 * The backoff curve lives here rather than in the caller so a retry scheduled by
 * the bulk endpoint and one scheduled by a future cron agree. Permanent failures
 * get no `next_retry_at` at all: there is nothing to come back for.
 */
create or replace function public.record_booking_failure(
  p_tenant_id uuid,
  p_order_id  uuid,
  p_courier   text,
  p_kind      text,
  p_message   text,
  p_code      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.courier_booking_failures
    (tenant_id, order_id, courier, kind, error_code, error_message, attempts, next_retry_at)
  values (
    p_tenant_id, p_order_id, p_courier, p_kind, p_code, left(p_message, 1000), 1,
    case when p_kind = 'transient' then now() + interval '2 minutes' end)
  on conflict (tenant_id, order_id, courier) do update
    set kind          = excluded.kind,
        error_code    = excluded.error_code,
        error_message = excluded.error_message,
        attempts      = public.courier_booking_failures.attempts + 1,
        resolved_at   = null,
        -- Exponential, capped at an hour: a courier that has been down for an hour
        -- is not going to be fixed by asking every two minutes.
        next_retry_at = case
          when excluded.kind = 'transient' then
            now() + least(
              interval '1 hour',
              (interval '2 minutes' * power(2, public.courier_booking_failures.attempts)))
        end;
end;
$$;

/**
 * Which orders are ready to be booked, with everything a courier needs.
 *
 * One round trip for the whole batch. The alternative — fetch 40 orders, then 40
 * address lookups — is 80 queries before the first HTTP call, on top of the 40 that
 * are the actual work.
 *
 * Returns the tenant's origin and sender details alongside, because every booking
 * in the batch shares them and a courier needs both ends of the journey.
 */
create or replace function public.courier_booking_batch(
  p_tenant_id uuid,
  p_order_ids uuid[],
  p_courier   text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_account record;
begin
  if not public.has_tenant_role(p_tenant_id, 'packer') then
    raise exception 'Not allowed to book shipments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_account from public.courier_accounts
   where tenant_id = p_tenant_id and courier = p_courier and is_enabled;

  if v_account.id is null then
    raise exception 'That courier is not connected'
      using errcode = 'feature_not_supported', hint = 'courier_not_connected';
  end if;

  return jsonb_build_object(
    'accountId',  v_account.id,
    'courier',    v_account.courier,
    'origin',     v_account.origin_address,
    'senderName', v_account.sender_name,
    'senderPhone',v_account.sender_phone,
    'accountRef', v_account.account_ref,
    'orders', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',            o.id,
        'orderNumber',   o.order_number,
        'contactName',   o.contact_name,
        'contactPhone',  o.contact_phone,
        'address',       o.shipping_address,
        'notes',         o.notes,
        -- What the rider collects. Zero for anything already paid — handing a rider
        -- an amount to collect on a prepaid order is how a buyer pays twice.
        'codAmount',     case when o.payment_method = 'cod' and o.payment_status <> 'paid'
                              then o.grand_total_centavos else 0 end,
        'declaredValue', o.grand_total_centavos,
        'weightGrams',   greatest(
                           coalesce((select sum(coalesce(v.weight_grams, 0) * oi.qty)
                                     from public.order_items oi
                                       left join public.product_variants v on v.id = oi.variant_id
                                     where oi.order_id = o.id), 0),
                           -- A courier rejects a zero-weight parcel, and an unweighed
                           -- product is common early on. 100g is a small envelope.
                           100)
      ) order by o.order_number), '[]'::jsonb)
      from public.orders o
      where o.tenant_id = p_tenant_id
        and o.id = any(p_order_ids)
        -- Already-booked orders are excluded rather than rejected: re-running a
        -- batch after a partial failure must book only what is missing.
        and not exists (
          select 1 from public.shipments s
          where s.order_id = o.id and s.status <> 'cancelled')
    )
  );
end;
$$;

/** Labels for a batch, for the merged PDF. */
create or replace function public.shipment_labels(
  p_tenant_id uuid,
  p_order_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'orderNumber', o.order_number,
    'waybill',     s.waybill,
    'courier',     s.courier,
    'labelUrl',    s.label_url
  ) order by o.order_number), '[]'::jsonb)
  from public.shipments s
    join public.orders o on o.id = s.order_id
  where s.tenant_id = p_tenant_id
    and s.order_id = any(p_order_ids)
    and s.label_url is not null
    and public.is_tenant_member(p_tenant_id);
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.courier_accounts          enable row level security;
alter table public.courier_accounts          force  row level security;
alter table public.shipments                 enable row level security;
alter table public.shipments                 force  row level security;
alter table public.courier_booking_failures  enable row level security;
alter table public.courier_booking_failures  force  row level security;

create policy "Admins read courier accounts" on public.courier_accounts for select to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins add courier accounts" on public.courier_accounts for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update courier accounts" on public.courier_accounts for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete courier accounts" on public.courier_accounts for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- A packer needs to see the waybill they are sticking on a box.
create policy "Members read shipments" on public.shipments for select to authenticated
  using (public.is_tenant_member(tenant_id));
-- Writes go through record_shipment, which keeps the order's status in step.

create policy "Members read booking failures" on public.courier_booking_failures
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
/**
 * `credentials_encrypted` is absent from the SELECT grant.
 *
 * It is a ciphertext, so reading it is not immediately catastrophic — but handing
 * every admin the encrypted blob turns "steal the key" into a complete attack
 * rather than half of one. The column list is the only way to withhold a column;
 * RLS is row-level.
 */
grant select (id, tenant_id, courier, origin_address, sender_name, sender_phone,
              account_ref, is_live, is_enabled, connected_at, created_at, updated_at)
  on public.courier_accounts to authenticated;
grant insert, update, delete on public.courier_accounts to authenticated;
grant select on public.courier_accounts_safe        to authenticated;
grant select on public.shipments                    to authenticated;
grant select on public.courier_booking_failures     to authenticated;

grant execute on function public.courier_booking_batch(uuid, uuid[], text) to authenticated;
grant execute on function public.shipment_labels(uuid, uuid[])             to authenticated;

/**
 * Service-role only, and `from public` rather than `from anon, authenticated`.
 *
 * Postgres grants EXECUTE to PUBLIC by default and revoking from a named role does
 * not remove a privilege held through PUBLIC. That trap shipped
 * `record_payment_event` callable by anon in phase 8; the CI step added then covers
 * these too.
 *
 * `set_courier_credentials` and `courier_credentials` take the encryption key as an
 * argument, so anything that can call them can decrypt. `record_shipment` moves an
 * order to shipped.
 */
revoke all on function public.set_courier_credentials(uuid, text, jsonb, text) from public;
revoke all on function public.courier_credentials(uuid, text)                  from public;
revoke all on function public.record_shipment(uuid, uuid, text, text, text, text, bigint, bigint, int, jsonb) from public;
revoke all on function public.record_booking_failure(uuid, uuid, text, text, text, text) from public;

revoke all on function public.courier_booking_batch(uuid, uuid[], text) from public;
revoke all on function public.shipment_labels(uuid, uuid[])             from public;
grant execute on function public.courier_booking_batch(uuid, uuid[], text) to authenticated;
grant execute on function public.shipment_labels(uuid, uuid[])             to authenticated;

-- ---------------------------------------------------------------------------
-- Fixing a regression this file's own pattern introduced in phase 8
-- ---------------------------------------------------------------------------
/**
 * `revoke ... from public` locked out the service role as well.
 *
 * Phase 8 found that `revoke ... from anon, authenticated` does nothing when the
 * privilege is held through PUBLIC, and switched to `revoke ... from public`. That
 * was the right fix for the hole — and it removed `service_role`'s access too,
 * because in Supabase `service_role` is not a superuser: it has `BYPASSRLS`, which
 * bypasses *policies*, not *grants*.
 *
 * So from that commit until this one, the payment webhook answered
 * "permission denied for function record_payment_event" — a paid GCash order would
 * never have reached `paid`. The phase-8 HTTP proof ran *before* the revoke and was
 * not repeated after it, which is the actual mistake: a security fix changed the
 * runtime behaviour of the thing it was protecting, and only the SQL suite was
 * re-run.
 *
 * The grants below are explicit rather than relying on PUBLIC, so both properties
 * are now stated rather than inherited: no client role may execute these, and the
 * server may. The CI step asserts both directions for exactly this reason —
 * "unreachable by anon" alone is satisfied by a function nobody can call at all.
 *
 * Phase 8's migration is already pushed and migrations are append-only, so this
 * lives here.
 */
grant execute on function public.record_payment_event(text, text, text, text, text, bigint, jsonb, bigint, timestamptz) to service_role;
grant execute on function public.attach_payment_charge(uuid, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.payment_account_for_webhook(text)          to service_role;
grant execute on function public.payment_credentials_for_payment(uuid)      to service_role;
grant execute on function public.sync_order_payment_status(uuid, text)      to service_role;
grant execute on function public.log_integration_attempt(uuid, text, text, text, text, int, text, text, int, int) to service_role;

-- The same, for this phase's server-called functions.
grant execute on function public.set_courier_credentials(uuid, text, jsonb, text) to service_role;
grant execute on function public.courier_credentials(uuid, text)                  to service_role;
grant execute on function public.record_shipment(uuid, uuid, text, text, text, text, bigint, bigint, int, jsonb) to service_role;
grant execute on function public.record_booking_failure(uuid, uuid, text, text, text, text) to service_role;
