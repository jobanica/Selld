/**
 * Phase 11 — Tracking and buyer notifications.
 *
 * The done-when is unusual: it is not a stopwatch or a threshold, it is the
 * *absence* of a message. "Nasaan na po order ko" must stop being asked, which
 * means the buyer has to already know. So the design question all through this file
 * is not "can we send an SMS" but "does the buyer find out without asking".
 *
 * Three things follow.
 *
 * ## Every status change fires exactly once, or the seller pays twice
 *
 * A courier's webhook is redelivered, its polling fallback sees the same scan, and
 * both land here. `shipment_events` carries
 * `unique (shipment_id, raw_code, occurred_at)` — the triple that identifies a
 * physical scan — so a duplicate collapses on insert and the notification that
 * hangs off it never runs. Same shape as phase 8's `webhook_events`, for the same
 * reason: replay safety is a constraint, not a code path someone has to remember.
 *
 * A duplicate SMS is not a cosmetic bug here. It costs the seller ₱0.50, and a
 * buyer who gets "your order is out for delivery" four times learns to ignore the
 * one that matters.
 *
 * ## The buyer needs a link, not just a text
 *
 * `/track/{order_number}` is public and needs no login, because a buyer who has to
 * remember a password will message the seller instead — which is the exact
 * behaviour this phase exists to eliminate. That makes the order number a
 * capability, so the page is deliberately thin: status and a timeline, never the
 * address, never the phone number, never what was bought.
 *
 * ## Templates are the seller's words
 *
 * Taglish, per tenant, editable. A generic English template reads as a system
 * message and gets ignored; the seller's own voice gets read. They are also where
 * the peso sign must not appear — `₱` forces UCS-2 and halves the segment budget
 * from 160 characters to 70, doubling the bill. The default templates say "PHP",
 * and `sms_render_template` is where a seller's edit gets checked for it.
 */

-- ---------------------------------------------------------------------------
-- Shipment events
-- ---------------------------------------------------------------------------
create table public.shipment_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  shipment_id uuid not null,

  /** Selld's vocabulary. The courier's own code is kept beside it, never instead. */
  status text not null check (
    status in ('booked', 'picked_up', 'in_transit', 'out_for_delivery',
               'delivered', 'delivery_failed', 'returning', 'returned',
               'cancelled', 'unknown')
  ),
  raw_code    text not null,
  description text,
  location    text,
  occurred_at timestamptz not null,

  /** `webhook` or `poll` — which path saw it first, for diagnosing a quiet courier. */
  source text not null default 'webhook' check (source in ('webhook', 'poll', 'manual')),
  raw    jsonb,

  created_at timestamptz not null default now(),

  /**
   * The triple that identifies one physical scan.
   *
   * Not the courier's event id: J&T does not send one, and Flash's is absent from
   * its push payload. A scan is "this parcel, this status code, at this instant",
   * and that is stable across a webhook and the poller both seeing it.
   */
  unique (shipment_id, raw_code, occurred_at),

  foreign key (tenant_id, shipment_id)
    references public.shipments (tenant_id, id) on delete cascade
);

create index shipment_events_shipment_idx
  on public.shipment_events (tenant_id, shipment_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- SMS templates
-- ---------------------------------------------------------------------------
/**
 * What the buyer actually reads.
 *
 * One row per (tenant, event, locale). Seeded with Taglish defaults on tenant
 * creation so a store that never opens this screen still sends something that
 * sounds like a person.
 */
create table public.sms_templates (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  event  text not null check (
    event in ('order_confirmed', 'shipped', 'out_for_delivery', 'delivered', 'rts')
  ),
  locale text not null default 'tl' check (locale in ('en', 'tl')),

  body      text not null check (length(btrim(body)) between 1 and 320),
  is_enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, event, locale)
);

create index sms_templates_tenant_idx on public.sms_templates (tenant_id);

create trigger sms_templates_set_updated_at
  before update on public.sms_templates
  for each row execute function public.set_updated_at();

/**
 * The defaults, in Taglish.
 *
 * Deliberately not deep Tagalog — "order", "delivery", "tracking" are the words
 * sellers and buyers actually use, and a machine-translated message costs
 * credibility. And deliberately `PHP`, never `₱`: one peso sign forces the whole
 * message to UCS-2 and halves the per-segment budget from 160 characters to 70,
 * which doubles the seller's bill on every send.
 */
create or replace function public.default_sms_templates()
returns table (event text, locale text, body text)
language sql
immutable
as $$
  values
    ('order_confirmed', 'tl', 'Salamat {{name}}! Received na namin ang order mo {{orderNumber}}, PHP {{total}}. Susundan mo dito: {{trackUrl}}'),
    ('order_confirmed', 'en', 'Thanks {{name}}! We got your order {{orderNumber}}, PHP {{total}}. Track it here: {{trackUrl}}'),
    ('shipped',          'tl', 'Padala na ang order mo {{orderNumber}} via {{courier}}. Waybill {{waybill}}. Track: {{trackUrl}}'),
    ('shipped',          'en', 'Your order {{orderNumber}} is on its way via {{courier}}. Waybill {{waybill}}. Track: {{trackUrl}}'),
    ('out_for_delivery','tl', 'Out for delivery na ang order mo {{orderNumber}} ngayon. Pakihanda ang PHP {{codDue}} kung COD. {{trackUrl}}'),
    ('out_for_delivery','en', 'Your order {{orderNumber}} is out for delivery today. Please have PHP {{codDue}} ready if COD. {{trackUrl}}'),
    ('delivered',        'tl', 'Delivered na ang order mo {{orderNumber}}. Salamat sa tiwala! - {{storeName}}'),
    ('delivered',        'en', 'Your order {{orderNumber}} has been delivered. Thank you! - {{storeName}}'),
    ('rts',              'tl', 'Hindi na-deliver ang order mo {{orderNumber}} kaya pabalik na ito. Message mo lang kami para ma-resend. - {{storeName}}'),
    ('rts',              'en', 'Your order {{orderNumber}} could not be delivered and is on its way back. Message us to resend. - {{storeName}}');
$$;

-- ---------------------------------------------------------------------------
-- SMS credits
-- ---------------------------------------------------------------------------
/**
 * A ledger, not a counter.
 *
 * Same reasoning as `stock_movements` in phase 4: a balance you can only read is a
 * balance nobody can explain. A seller who sees "12 credits left" and cannot see
 * where the other 88 went stops trusting the number, and then stops trusting the
 * bill.
 *
 * `balance_after` is stored on each row rather than derived on read, because the
 * common query is "what is my balance" and summing a growing ledger for every
 * outbound SMS is the wrong shape. It is asserted against the running sum by the
 * tenancy suite.
 */
create table public.sms_credit_entries (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  /**
   * Ledger order, and the reason it is not `created_at`.
   *
   * `now()` is the *transaction* timestamp, so every row written in one
   * transaction shares it — the trial grant and a send that follows it are
   * indistinguishable by time. Ordering by `created_at desc, id desc` then breaks
   * the tie on a random uuid, and `sms_credit_balance` returns whichever of the
   * two rows happened to sort higher. It reads the correct balance about half the
   * time, which is the worst kind of wrong: a seller sees their balance flick
   * between two numbers and cannot reproduce it.
   *
   * An identity column is monotonic within a transaction as well as across one.
   */
  seq bigint generated always as identity,

  /** Positive for a top-up, negative for a send. */
  delta         int not null check (delta <> 0),
  balance_after int not null check (balance_after >= 0),

  reason text not null check (
    reason in ('topup', 'send', 'refund', 'adjustment', 'trial')
  ),
  sms_log_id uuid references public.sms_logs (id) on delete set null,
  note       text,

  created_at timestamptz not null default now()
);

create unique index sms_credit_entries_tenant_seq_idx
  on public.sms_credit_entries (tenant_id, seq desc);

/**
 * The balance, with no authorisation at all.
 *
 * Same split as `apply_reservation` in phase 6: the unchecked primitive is here,
 * the membership check is on the wrapper below, and the `SECURITY DEFINER`
 * functions that need a balance mid-send call *this* one. They have to — they run
 * as the definer with no JWT, so a membership check would tell the notification
 * path that a seller it is texting for has no credits, and silence every message.
 *
 * Not granted to anyone. The only callers are the definer-owned functions in this
 * file, which run as the owner and need no grant.
 */
create or replace function public.sms_credit_balance_raw(p_tenant_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select balance_after from public.sms_credit_entries
    where tenant_id = p_tenant_id
    order by seq desc
    limit 1), 0);
$$;

/**
 * The balance, for the seller it belongs to.
 *
 * `SECURITY DEFINER` plus a grant to `authenticated` is *not* tenant scoping —
 * the definer bypasses the RLS on `sms_credit_entries`, so without this check any
 * signed-in user could read any store's balance by passing its tenant id. Small
 * as leaks go, and still a leak: it says how much a competitor spends on SMS, and
 * how close they are to running out.
 *
 * Caught by `supabase/tests/tenancy-isolation.sql`, which asks Marlon for Rhea's
 * balance and expects nothing.
 */
create or replace function public.sms_credit_balance(p_tenant_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_tenant_member(p_tenant_id)
              then public.sms_credit_balance_raw(p_tenant_id) end;
$$;

/**
 * Move the ledger.
 *
 * Serialised per tenant with an advisory lock, because two SMS going out at once
 * would otherwise both read the same balance and write the same `balance_after` —
 * the ledger would still sum correctly but the stored balance would be wrong, which
 * is exactly the drift `balance_after` exists to avoid.
 *
 * Returns null when a send would overdraw. The caller must treat that as "do not
 * send", not as "send anyway and reconcile later".
 */
create or replace function public.sms_credit_move(
  p_tenant_id uuid,
  p_delta     int,
  p_reason    text,
  p_sms_log_id uuid default null,
  p_note      text default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance int;
  v_next    int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 11));

  select public.sms_credit_balance_raw(p_tenant_id) into v_balance;
  v_next := v_balance + p_delta;

  if v_next < 0 then
    return null;
  end if;

  insert into public.sms_credit_entries
    (tenant_id, delta, balance_after, reason, sms_log_id, note)
  values (p_tenant_id, p_delta, v_next, p_reason, p_sms_log_id, p_note);

  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Applying a tracking event
-- ---------------------------------------------------------------------------
/**
 * Which fulfilment status a courier scan implies.
 *
 * A table again, for the same reason `order_transitions` is one: this mapping is
 * read by the notification path and by the UI, and two copies is how a screen
 * disagrees with the database about where a parcel is.
 *
 * `null` means "does not move the order" — a parcel being scanned at a sorting
 * centre is real and belongs on the timeline, but the order is still `shipped`.
 */
create table public.shipment_status_map (
  shipment_status text primary key,
  order_status    text,
  /** Which SMS to send, if any. */
  notify_event    text
);

insert into public.shipment_status_map (shipment_status, order_status, notify_event) values
  ('booked',           'shipped',   null),
  ('picked_up',        'shipped',   null),
  ('in_transit',       'shipped',   null),
  ('out_for_delivery', 'shipped',   'out_for_delivery'),
  ('delivered',        'delivered', 'delivered'),
  ('delivery_failed',  null,        null),
  ('returning',        'rts',       'rts'),
  ('returned',         'rts',       null),
  ('cancelled',        null,        null),
  ('unknown',          null,        null);

alter table public.shipment_status_map enable row level security;
create policy "Anyone signed in reads the map" on public.shipment_status_map
  for select to authenticated using (true);
grant select on public.shipment_status_map to authenticated;

/**
 * Record a courier scan and move everything that follows from it.
 *
 * Returns a jsonb verdict rather than raising, because the webhook handler must
 * answer 200 to a duplicate — a non-2xx makes the courier retry, and retrying a
 * duplicate forever is worse than recording it once.
 *
 * Order of operations, and it is the safety property:
 *
 *   1. insert into shipment_events   <- unique (shipment_id, raw_code, occurred_at)
 *   2. if that conflicted, return 'duplicate' and touch nothing else
 *   3. only then move the shipment, the order, and decide whether to notify
 *
 * Step 2 is why a redelivered webhook does not send a second SMS.
 *
 * **Out-of-order scans are ignored for the *order's* status but still recorded.**
 * Couriers deliver events out of order routinely, and a late "in transit" arriving
 * after "delivered" must not un-deliver the order. The event still lands on the
 * timeline, because it happened.
 */
create or replace function public.record_shipment_event(
  p_courier     text,
  p_waybill     text,
  p_status      text,
  p_raw_code    text,
  p_occurred_at timestamptz,
  p_description text default null,
  p_location    text default null,
  p_source      text default 'webhook',
  p_raw         jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment record;
  v_order    record;
  v_event_id uuid;
  v_map      record;
  v_latest   timestamptz;
  v_moved    boolean := false;
begin
  select * into v_shipment from public.shipments
   where courier = p_courier and waybill = p_waybill;

  if v_shipment.id is null then
    return jsonb_build_object('outcome', 'unmatched', 'applied', false);
  end if;

  -- ---- 1. De-duplicate, before anything is applied ----------------------
  insert into public.shipment_events
    (tenant_id, shipment_id, status, raw_code, description, location,
     occurred_at, source, raw)
  values (v_shipment.tenant_id, v_shipment.id, p_status, p_raw_code,
          p_description, p_location, p_occurred_at, p_source, p_raw)
  on conflict (shipment_id, raw_code, occurred_at) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Already seen, by the webhook or by the poller. No second SMS.
    return jsonb_build_object('outcome', 'duplicate', 'applied', false);
  end if;

  -- ---- 2. Is this the newest thing we know about this parcel? ------------
  select max(occurred_at) into v_latest
  from public.shipment_events where shipment_id = v_shipment.id;

  -- A scan older than one already recorded is history, not news. It is on the
  -- timeline (step 1) but must not drive the parcel's current status.
  if p_occurred_at < v_latest then
    return jsonb_build_object('outcome', 'recorded_out_of_order', 'applied', false,
                              'eventId', v_event_id);
  end if;

  update public.shipments
     set status = p_status,
         delivered_at = case when p_status = 'delivered'
                             then coalesce(delivered_at, p_occurred_at) end
   where id = v_shipment.id;

  -- ---- 3. Move the order, if this status implies a move -------------------
  select * into v_map from public.shipment_status_map where shipment_status = p_status;
  select * into v_order from public.orders where id = v_shipment.order_id;

  if v_map.order_status is not null
     and v_order.fulfillment_status is distinct from v_map.order_status
     -- Never walk an order backwards. `delivered` and `cancelled` are terminal.
     and v_order.fulfillment_status not in ('delivered', 'cancelled') then
    update public.orders
       set fulfillment_status = v_map.order_status
     where id = v_order.id;

    insert into public.order_status_history
      (tenant_id, order_id, field, from_status, to_status, note)
    values (v_shipment.tenant_id, v_order.id, 'fulfillment_status',
            v_order.fulfillment_status, v_map.order_status,
            format('%s: %s', p_courier, coalesce(p_description, p_raw_code)));
    v_moved := true;
  end if;

  return jsonb_build_object(
    'outcome',     'applied',
    'applied',     true,
    'eventId',     v_event_id,
    'tenantId',    v_shipment.tenant_id,
    'orderId',     v_shipment.order_id,
    'orderNumber', v_order.order_number,
    'movedOrder',  v_moved,
    -- What the caller should send, if anything. Deciding here rather than in the
    -- handler keeps the notification rule in one place.
    'notifyEvent', v_map.notify_event
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Rendering and sending
-- ---------------------------------------------------------------------------
/**
 * The message for one event, with everything already substituted.
 *
 * Returns null when the template is disabled or the tenant has no credits, so the
 * caller has one thing to check rather than three. Deliberately does *not* send:
 * the provider call belongs in the server, and a database function that made
 * network calls would be untestable and unrollbackable.
 */
create or replace function public.sms_render_for_order(
  p_order_id uuid,
  p_event    text,
  /**
   * The *platform* origin — `https://selld.ph`, or `http://localhost:5174` in
   * dev — not the origin of whatever request happens to be running.
   *
   * The tracking link has to point at the seller's own storefront, and the
   * request that triggers a notification is a courier webhook arriving on the
   * platform's webhook host. Substituting that request's origin produced
   * `http://127.0.0.1:5184/track/0001` in dev and would have produced a link to
   * the webhook endpoint's hostname in production — a text telling a buyer to
   * visit a URL that is not their seller's shop, and on a custom-domain store,
   * not even the right company.
   */
  p_root_url text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order    record;
  v_tenant   record;
  v_shipment record;
  v_locale   text;
  v_body     text;
  v_cod      bigint;
  v_scheme   text;
  v_host     text;
  v_store    text;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then return null; end if;

  select * into v_tenant from public.tenants where id = v_order.tenant_id;

  select * into v_shipment from public.shipments
   where order_id = p_order_id and status <> 'cancelled'
   order by created_at desc limit 1;

  -- The store's own locale. A Taglish store texting English reads as a different
  -- company than the one the buyer bought from.
  v_locale := coalesce((
    select value #>> '{}' from public.tenant_settings
    where tenant_id = v_order.tenant_id and key = 'store.locale'), 'tl');

  select body into v_body from public.sms_templates
   where tenant_id = v_order.tenant_id and event = p_event
     and locale = v_locale and is_enabled;

  if v_body is null then return null; end if;

  v_cod := case when v_order.payment_method = 'cod' and v_order.payment_status <> 'paid'
                then v_order.grand_total_centavos::bigint else 0 end;

  v_body := replace(v_body, '{{name}}', split_part(v_order.contact_name, ' ', 1));
  v_body := replace(v_body, '{{orderNumber}}', v_order.order_number);
  v_body := replace(v_body, '{{storeName}}', v_tenant.name);
  v_body := replace(v_body, '{{total}}',
                    to_char(v_order.grand_total_centavos::numeric / 100, 'FM999999990.00'));
  v_body := replace(v_body, '{{codDue}}', to_char(v_cod::numeric / 100, 'FM999999990.00'));
  v_body := replace(v_body, '{{courier}}', upper(coalesce(v_shipment.courier, '')));
  v_body := replace(v_body, '{{waybill}}', coalesce(v_shipment.waybill, ''));
  -- The seller's storefront: their custom domain if they have one, otherwise
  -- their subdomain of the platform root. Same rule `resolveSurface` applies to
  -- an inbound request, so the link always lands where the buyer bought.
  v_scheme := coalesce(nullif(split_part(p_root_url, '://', 1), ''), 'https');
  v_host   := coalesce(nullif(split_part(p_root_url, '://', 2), ''), 'selld.ph');
  v_store  := case
                when coalesce(v_tenant.custom_domain, '') <> ''
                  then v_scheme || '://' || v_tenant.custom_domain
                else v_scheme || '://' || v_tenant.slug || '.' || v_host
              end;

  v_body := replace(v_body, '{{trackUrl}}',
                    v_store || '/track/' || v_order.order_number);

  return jsonb_build_object(
    'to',          v_order.contact_phone,
    'body',        v_body,
    'tenantId',    v_order.tenant_id,
    'orderId',     v_order.id,
    'orderNumber', v_order.order_number,
    'balance',     public.sms_credit_balance_raw(v_order.tenant_id)
  );
end;
$$;

/**
 * Record a sent notification and take the credit.
 *
 * `idempotency_key` is `(order, event)`, so the same notification for the same
 * order can never be logged — or charged — twice, whatever path reached here.
 * That is the second half of the duplicate defence: the first is
 * `shipment_events`, and this catches the case where a *different* scan maps to
 * the same buyer-facing event.
 */
create or replace function public.record_tracking_sms(
  p_tenant_id uuid,
  p_order_id  uuid,
  p_event     text,
  p_to        text,
  p_body      text,
  p_provider  text,
  p_provider_ref text,
  p_status    text,
  p_cost      bigint default 0,
  p_segments  int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      text := p_order_id::text || ':' || p_event;
  v_log_id   uuid;
  v_balance  int;
begin
  -- Already notified for this order and event.
  if exists (
    select 1 from public.integration_logs
    where tenant_id = p_tenant_id and idempotency_key = v_key
  ) then
    return jsonb_build_object('outcome', 'duplicate', 'sent', false);
  end if;

  insert into public.sms_logs
    (tenant_id, "to", body, provider, provider_ref, status, cost_centavos,
     segments, purpose, order_id)
  values (p_tenant_id, p_to, p_body, p_provider, p_provider_ref, p_status,
          greatest(coalesce(p_cost, 0), 0), greatest(coalesce(p_segments, 1), 1),
          'tracking', p_order_id)
  returning id into v_log_id;

  insert into public.integration_logs
    (tenant_id, provider, operation, idempotency_key, status)
  values (p_tenant_id, p_provider, 'sms.tracking', v_key,
          case when p_status in ('sent', 'delivered', 'queued') then 'success' else 'failed' end)
  on conflict (tenant_id, idempotency_key) do nothing;

  -- One credit per segment. A failed send is not charged: the seller did not get
  -- what they paid for.
  if p_status in ('sent', 'delivered', 'queued') then
    v_balance := public.sms_credit_move(
      p_tenant_id, -greatest(coalesce(p_segments, 1), 1), 'send', v_log_id, p_event);
  else
    v_balance := public.sms_credit_balance_raw(p_tenant_id);
  end if;

  return jsonb_build_object(
    'outcome', 'sent', 'sent', true, 'smsLogId', v_log_id, 'balance', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- The public tracking page
-- ---------------------------------------------------------------------------
/**
 * What a stranger with an order number may see.
 *
 * The page needs no login, which makes the order number a capability — so this is
 * deliberately thin. No address, no phone number, no line items, no totals. Status,
 * a timeline, the courier and the waybill: enough to answer "nasaan na po order ko"
 * and nothing that would make a leaked order number worth having.
 *
 * Order numbers are per tenant (`0001`, `0002`, …), so the store must be named too
 * — otherwise `0001` would be ambiguous across every store on the platform.
 */
create or replace function public.public_tracking(
  p_slug         text,
  p_domain       text,
  p_order_number text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_order     record;
  v_shipment  record;
begin
  v_tenant_id := public.storefront_tenant_id(p_slug, p_domain);
  if v_tenant_id is null then return null; end if;

  select * into v_order from public.orders
   where tenant_id = v_tenant_id and order_number = btrim(p_order_number);
  if v_order.id is null then return null; end if;

  select * into v_shipment from public.shipments
   where order_id = v_order.id and status <> 'cancelled'
   order by created_at desc limit 1;

  return jsonb_build_object(
    'orderNumber', v_order.order_number,
    'placedAt',    v_order.placed_at,
    'status',      v_order.fulfillment_status,
    'paymentStatus', v_order.payment_status,
    -- The first name only. "Rhea S." confirms to the right person that they have
    -- the right order, without handing a stranger a full name.
    'firstName',   split_part(v_order.contact_name, ' ', 1),
    -- The destination city, not the street. Enough to recognise your own parcel.
    'city',        v_order.shipping_address ->> 'cityName',
    'store', (select jsonb_build_object('name', t.name, 'slug', t.slug)
              from public.tenants t where t.id = v_tenant_id),
    'courier',     v_shipment.courier,
    'waybill',     v_shipment.waybill,
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'status',      e.status,
        'description', e.description,
        'location',    e.location,
        'occurredAt',  e.occurred_at
      ) order by e.occurred_at desc), '[]'::jsonb)
      from public.shipment_events e where e.shipment_id = v_shipment.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Which shipments need polling
-- ---------------------------------------------------------------------------
/**
 * The fallback for couriers that do not push.
 *
 * Only parcels that are still moving, and only those we have not heard about
 * recently — polling a delivered parcel forever is how a courier starts rate
 * limiting the account that matters.
 */
create or replace function public.shipments_to_poll(
  p_limit int default 100,
  p_stale_after interval default interval '4 hours'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', s.tenant_id,
    'courier',  s.courier,
    'waybill',  s.waybill
  )), '[]'::jsonb)
  from public.shipments s
  where s.status not in ('delivered', 'returned', 'cancelled')
    and coalesce(
      (select max(e.occurred_at) from public.shipment_events e where e.shipment_id = s.id),
      s.booked_at) < now() - p_stale_after
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.shipment_events     enable row level security;
alter table public.shipment_events     force  row level security;
alter table public.sms_templates       enable row level security;
alter table public.sms_templates       force  row level security;
alter table public.sms_credit_entries  enable row level security;
alter table public.sms_credit_entries  force  row level security;

create policy "Members read shipment events" on public.shipment_events for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Members read sms templates" on public.sms_templates for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Admins write sms templates" on public.sms_templates for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update sms templates" on public.sms_templates for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));

-- The ledger is readable, never writable from a client: a balance a seller can
-- edit is not a balance.
create policy "Members read sms credits" on public.sms_credit_entries for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select on public.shipment_events    to authenticated;
grant select on public.sms_credit_entries to authenticated;
grant select, insert, update on public.sms_templates to authenticated;

revoke all on function public.sms_credit_balance_raw(uuid) from public;
grant execute on function public.sms_credit_balance(uuid) to authenticated;
grant execute on function public.default_sms_templates()  to authenticated;

-- The tracking page is the one thing here a buyer may reach.
revoke all on function public.public_tracking(text, text, text) from public;
grant execute on function public.public_tracking(text, text, text) to anon, authenticated;

/**
 * Service-role only, and `from public` first — see phase 8 and 10.
 *
 * `record_shipment_event` moves orders. `record_tracking_sms` spends a seller's
 * credits. `sms_credit_move` writes the ledger. `shipments_to_poll` enumerates
 * every in-flight parcel on the platform, across tenants, which is the poller's job
 * and nobody else's.
 *
 * Each is granted back to `service_role` explicitly, because `revoke ... from
 * public` removes it there too — the regression phase 10 found.
 */
revoke all on function public.record_shipment_event(text, text, text, text, timestamptz, text, text, text, jsonb) from public;
revoke all on function public.record_tracking_sms(uuid, uuid, text, text, text, text, text, text, bigint, int) from public;
revoke all on function public.sms_credit_move(uuid, int, text, uuid, text) from public;
revoke all on function public.sms_render_for_order(uuid, text, text) from public;
revoke all on function public.shipments_to_poll(int, interval) from public;

grant execute on function public.record_shipment_event(text, text, text, text, timestamptz, text, text, text, jsonb) to service_role;
grant execute on function public.record_tracking_sms(uuid, uuid, text, text, text, text, text, text, bigint, int) to service_role;
grant execute on function public.sms_credit_move(uuid, int, text, uuid, text) to service_role;
grant execute on function public.sms_render_for_order(uuid, text, text) to service_role;
grant execute on function public.shipments_to_poll(int, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Seeding
-- ---------------------------------------------------------------------------
-- Existing tenants get the defaults and a trial credit balance.
insert into public.sms_templates (tenant_id, event, locale, body)
select t.id, d.event, d.locale, d.body
from public.tenants t cross join public.default_sms_templates() d
on conflict (tenant_id, event, locale) do nothing;

insert into public.sms_credit_entries (tenant_id, delta, balance_after, reason, note)
select t.id, 100, 100, 'trial', 'Welcome credits'
from public.tenants t
where not exists (
  select 1 from public.sms_credit_entries e where e.tenant_id = t.id);

-- ---------------------------------------------------------------------------
-- New tenants get templates and trial credits too
-- ---------------------------------------------------------------------------
/**
 * The backfill above covers stores that already existed. Without this, every store
 * created *after* this migration would have no templates and no credits — so its
 * buyers would silently get no tracking texts at all, which is the entire phase
 * failing quietly for exactly the sellers who joined most recently.
 *
 * The same omission shipped in phase 8 (`payments.methods`) and was found by
 * connecting an account on a fresh store. Reproduced from the live definition; only
 * the new inserts are added.
 */
CREATE OR REPLACE FUNCTION public.seed_tenant_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- Phase 8. Which online methods the checkout page offers, intersected with
    -- whether the tenant has actually connected a payment account.
    (new.id, 'payments.methods', '["gcash","maya","grabpay","qrph","card"]'::jsonb),
    (new.id, 'orders.number_prefix', '""'::jsonb),
    (new.id, 'orders.auto_confirm', 'false'::jsonb),
    (new.id, 'catalog.presets', '[]'::jsonb),
    -- Phase 6. ₱80 is the going rate for Metro Manila small-parcel COD, and a
    -- default of 0 would silently ship everything free.
    (new.id, 'shipping.flat_centavos', '8000'::jsonb)
  on conflict (tenant_id, key) do nothing;

  -- Phase 11. A store that never opens the templates screen still texts its buyers
  -- in Taglish, and starts with enough credits to see the feature work.
  insert into public.sms_templates (tenant_id, event, locale, body)
  select new.id, d.event, d.locale, d.body from public.default_sms_templates() d
  on conflict (tenant_id, event, locale) do nothing;

  insert into public.sms_credit_entries (tenant_id, delta, balance_after, reason, note)
  values (new.id, 100, 100, 'trial', 'Welcome credits');

  -- Order numbering starts at 1 for every tenant.
  insert into public.order_counters (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;

  return new;
end;
$function$;