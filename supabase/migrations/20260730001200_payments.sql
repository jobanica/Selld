/**
 * Phase 8 — Payments.
 *
 * The done-when for this phase is a sentence about *inbound* messages: "a GCash
 * payment moves the order to `paid` via webhook with no polling, and replaying the
 * same webhook twice changes nothing." Both halves are schema problems before they
 * are code problems, and this file is where they are solved.
 *
 * ## Replay safety is a constraint, not a code path
 *
 * `webhook_events` carries `unique (provider, external_id)`. `record_payment_event`
 * inserts there *first* and returns early when the insert conflicts. So a duplicate
 * delivery cannot reach the order-mutating half of the function at all — replay
 * safety holds by construction rather than by every future edit remembering to
 * check. Xendit retries webhooks on any non-2xx and on timeouts, so duplicates are
 * the normal case, not an edge case.
 *
 * ## A webhook is an untrusted message until it is verified
 *
 * An unverified payment webhook is a "mark any order paid" endpoint. Verification
 * happens in the Node handler (`server/payment-webhook.ts`) before this function is
 * called, which is why `record_payment_event` is service-role only and granted to
 * neither `anon` nor `authenticated`. Exposing it to `authenticated` would let any
 * signed-in seller mark their own orders paid; exposing it to `anon` would let
 * anyone mark anyone's.
 *
 * ## The amount is checked, never assumed
 *
 * The provider tells us what the buyer actually paid. We compare it to what we
 * charged: short-pays land on `partial`, not `paid`. Trusting a provider-supplied
 * amount to mean "this order is settled" is the same class of mistake as trusting a
 * client-supplied price, which hard rule 6 already forbids on the way out.
 */

-- ---------------------------------------------------------------------------
-- Provider credentials
-- ---------------------------------------------------------------------------
/**
 * Per-tenant payment credentials.
 *
 * Each seller connects their own Xendit account, because the money must land in
 * their bank, not ours. That makes credentials tenant data — and the most dangerous
 * tenant data in the schema.
 *
 * Three things follow, and all three are enforced below rather than by convention:
 *
 * 1. **The secret columns have no SELECT grant.** RLS is row-level, so a policy
 *    cannot hide a column; the column list on the GRANT is the only way to say it.
 *    Same reasoning as `carts.token` in phase 6 and `invitations.token` in phase 2.
 *    Sellers read `payment_accounts_safe` instead, which reports whether a key is
 *    set without ever returning it.
 *
 * 2. **`webhook_slug` is how a webhook finds its tenant.** Xendit's callback token
 *    is a static per-account secret, so verifying a delivery means knowing whose
 *    account it belongs to *before* trusting anything in the body. Putting a tenant
 *    id in the URL would leak it to anyone who sees a webhook configuration screen;
 *    an opaque random slug identifies the account without naming the tenant.
 *
 * 3. **Nothing here is readable by `anon`.** A buyer never touches this table.
 */
create table public.payment_accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  provider     text not null check (provider in ('xendit')),

  -- Opaque, unguessable, and unique across all tenants: it is the path segment the
  -- provider posts to. 32 bytes of randomness, same budget as a cart token.
  webhook_slug text not null default encode(extensions.gen_random_bytes(32), 'hex'),

  -- Secrets. Never selectable by any client role — see the grants at the bottom.
  secret_key     text,
  callback_token text,

  is_live      boolean not null default false,
  is_enabled   boolean not null default false,
  connected_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (tenant_id, provider),
  unique (webhook_slug),
  -- An account cannot be switched on until it can actually take a payment and
  -- verify the result. Enabling it half-configured produces orders that are
  -- charged and never confirmed.
  constraint payment_accounts_enabled_needs_credentials check (
    not is_enabled or (secret_key is not null and callback_token is not null)
  )
);

create index payment_accounts_tenant_idx on public.payment_accounts (tenant_id);

create trigger payment_accounts_set_updated_at
  before update on public.payment_accounts
  for each row execute function public.set_updated_at();

/**
 * What a seller is allowed to see about their own credentials.
 *
 * Reports *whether* a key is present and the last four characters, which is enough
 * to answer "did my paste work?" and "is this the live key or the test one?" without
 * handing back anything usable.
 *
 * **Owner-run, not `security_invoker`,** and that is the whole trick. The view's
 * entire job is to derive facts from columns nobody may select — so under invoker's
 * rights it fails for every caller, including the account's owner, with
 * "permission denied for table payment_accounts". (Written that way first; the
 * tenancy suite caught it immediately.)
 *
 * Running as owner means RLS does not filter it, so the membership check moves
 * *into* the view. Same pattern as the `storefront_*` views in phase 5, and the
 * predicate is `is_tenant_member`, which the client cannot influence.
 */
create view public.payment_accounts_safe as
select
  a.id,
  a.tenant_id,
  a.provider,
  a.is_live,
  a.is_enabled,
  a.connected_at,
  a.secret_key is not null      as has_secret_key,
  a.callback_token is not null  as has_callback_token,
  right(a.secret_key, 4)        as secret_key_last4,
  a.created_at,
  a.updated_at
from public.payment_accounts a
where public.is_tenant_member(a.tenant_id);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
/**
 * One row per payment *attempt*, not one per order.
 *
 * An order legitimately accumulates several: a GCash invoice that expired, a second
 * that failed, then a bank transfer the seller recorded by hand. Collapsing them
 * into columns on `orders` would lose that history, and the history is exactly what
 * a seller needs when a buyer says "I already paid".
 *
 * `provider_ref` is the provider's own id. It is unique per tenant so a webhook can
 * find its payment without trusting anything else in the body.
 */
create table public.payments (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  order_id   uuid not null,

  provider   text not null check (provider in ('xendit', 'cod', 'manual')),
  method     text not null check (
    method in ('cod', 'gcash', 'maya', 'grabpay', 'card', 'bank', 'qrph')
  ),
  status     text not null default 'pending' check (
    status in ('pending', 'awaiting_action', 'paid', 'failed', 'expired',
               'refunded', 'partially_refunded')
  ),

  amount_centavos   public.centavos not null check (amount_centavos >= 0),
  -- What the provider kept. Usually only known at settlement, so nullable.
  fee_centavos      public.centavos check (fee_centavos >= 0),
  refunded_centavos public.centavos not null default 0 check (refunded_centavos >= 0),

  provider_ref text,
  -- Where to send the buyer to complete payment. Absent for COD and manual.
  checkout_url text,

  /**
   * Proof of a manual payment — a GCash receipt screenshot.
   *
   * A path into the *private* bucket, never the public one. These images carry a
   * buyer's name, the amount, and a reference number; a public URL for one is a
   * disclosure with no authentication in front of it, and object names are
   * guessable enough that "nobody knows the URL" is not a control.
   */
  proof_path text,
  proof_note text,

  paid_at    timestamptz,
  expires_at timestamptz,
  failure_reason text,

  -- The provider's payload, kept verbatim. When a seller and a provider disagree
  -- about what happened, the raw message is the only thing that settles it.
  raw jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, provider, provider_ref),

  -- Denormalised tenant_id with a composite FK, not a trigger: Postgres then makes
  -- a payment against another tenant's order unrepresentable, which holds even
  -- inside a SECURITY DEFINER function.
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade,

  -- A paid payment has to say when. Reporting "paid" with no timestamp makes every
  -- settlement report silently wrong.
  constraint payments_paid_has_timestamp check (status <> 'paid' or paid_at is not null),
  constraint payments_refund_within_amount check (refunded_centavos <= amount_centavos),
  -- Online methods go through a provider; COD and manual never do.
  constraint payments_provider_matches_method check (
    (provider = 'cod' and method = 'cod')
    or (provider = 'manual' and method in ('bank', 'gcash', 'maya', 'grabpay', 'card', 'qrph'))
    or (provider = 'xendit' and method in ('gcash', 'maya', 'grabpay', 'card', 'qrph'))
  )
);

create index payments_tenant_idx on public.payments (tenant_id, created_at desc);
create index payments_order_idx  on public.payments (tenant_id, order_id);
create index payments_status_idx on public.payments (tenant_id, status);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------
create table public.payment_refunds (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  payment_id uuid not null,

  amount_centavos public.centavos not null check (amount_centavos > 0),
  reason     text not null check (length(btrim(reason)) between 1 and 500),
  status     text not null default 'pending' check (
    status in ('pending', 'succeeded', 'failed')
  ),
  provider_ref text,
  actor_id   uuid references public.profiles (id) on delete set null,
  raw        jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, payment_id)
    references public.payments (tenant_id, id) on delete cascade
);

create index payment_refunds_tenant_idx  on public.payment_refunds (tenant_id, created_at desc);
create index payment_refunds_payment_idx on public.payment_refunds (tenant_id, payment_id);

create trigger payment_refunds_set_updated_at
  before update on public.payment_refunds
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook events
-- ---------------------------------------------------------------------------
/**
 * Every inbound provider message, recorded before it is acted on.
 *
 * `unique (provider, external_id)` is the load-bearing line in this migration. It is
 * deliberately **not** scoped by tenant: the uniqueness that matters is the
 * provider's own event id, and adding `tenant_id` to the key would let the same
 * event be processed twice by landing it against two tenants — which is precisely
 * the failure the constraint exists to prevent.
 *
 * Rows are kept after processing rather than deleted. When a seller reports an order
 * that "went paid on its own", the answer is in this table.
 */
create table public.webhook_events (
  id          uuid primary key default gen_random_uuid(),
  -- Nullable: a message can arrive that we cannot attribute (an event for an order
  -- that was deleted, or an unknown reference). We still record it, because an
  -- unattributable webhook is a symptom worth being able to see.
  tenant_id   uuid references public.tenants (id) on delete cascade,

  provider    text not null,
  external_id text not null,
  event_type  text,

  status      text not null default 'received' check (
    status in ('received', 'processed', 'ignored', 'failed')
  ),
  payload      jsonb not null,
  error_message text,
  processed_at timestamptz,
  created_at   timestamptz not null default now(),

  unique (provider, external_id)
);

create index webhook_events_tenant_idx on public.webhook_events (tenant_id, created_at desc);
create index webhook_events_status_idx on public.webhook_events (status, created_at desc)
  where status in ('received', 'failed');

-- ---------------------------------------------------------------------------
-- orders: statuses this phase makes reachable
-- ---------------------------------------------------------------------------
-- `grabpay` was in the core PaymentMethod union from phase 0 and missing from this
-- CHECK, so a GrabPay order was rejected by the database rather than by any rule
-- anyone had decided on. The spec lists it.
alter table public.orders drop constraint orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check (
  payment_method in ('cod', 'gcash', 'maya', 'grabpay', 'card', 'bank', 'qrph')
);

-- A partial refund is not the same as a partial payment, and reporting a refunded
-- order as 'partial' would put it in the "chase this buyer" bucket.
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (
  payment_status in ('unpaid', 'paid', 'partial', 'refunded', 'partially_refunded')
);

-- ---------------------------------------------------------------------------
-- Applying a payment to its order
-- ---------------------------------------------------------------------------
/**
 * Recompute an order's payment status from its payments, and record the move.
 *
 * Derived rather than assigned. Two payments against one order (a failed GCash, then
 * a bank transfer) must not leave the order in whichever state the *last* message
 * happened to describe — the order's status is a function of everything settled
 * against it, so it is computed that way.
 *
 * Writes `order_status_history` only on an actual transition, so a redelivered
 * webhook that survives to here still adds no noise to the timeline.
 */
create or replace function public.sync_order_payment_status(
  p_order_id uuid,
  p_note     text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    record;
  v_paid     bigint;
  v_refunded bigint;
  v_next     text;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return null;
  end if;

  select
    coalesce(sum(case when p.status in ('paid', 'partially_refunded')
                      then p.amount_centavos::bigint else 0 end), 0),
    coalesce(sum(p.refunded_centavos::bigint), 0)
  into v_paid, v_refunded
  from public.payments p
  where p.order_id = p_order_id;

  v_next := case
    when v_refunded >= v_paid and v_refunded > 0 then 'refunded'
    when v_refunded > 0                          then 'partially_refunded'
    when v_paid >= v_order.grand_total_centavos::bigint and v_paid > 0 then 'paid'
    when v_paid > 0                              then 'partial'
    else 'unpaid'
  end;

  if v_next is distinct from v_order.payment_status then
    update public.orders set payment_status = v_next where id = p_order_id;

    insert into public.order_status_history
      (tenant_id, order_id, field, from_status, to_status, note)
    values (v_order.tenant_id, p_order_id, 'payment_status',
            v_order.payment_status, v_next, p_note);
  end if;

  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- The inbound path
-- ---------------------------------------------------------------------------
/**
 * Record a verified provider event and apply it.
 *
 * Called by `server/payment-webhook.ts` with the service role, and **only** after
 * that handler has verified the delivery against the tenant's callback token. There
 * is no grant to `anon` or `authenticated`: this function moves money-state, and
 * anything that can call it can mark orders paid.
 *
 * Returns a jsonb verdict rather than raising, because the handler must answer 200
 * to a duplicate — a non-2xx makes Xendit retry, and retrying a duplicate forever is
 * a worse outcome than recording it once.
 *
 * The order of operations is the safety property:
 *
 *   1. insert into webhook_events        <- unique (provider, external_id)
 *   2. if that conflicted, return 'duplicate' and touch nothing else
 *   3. only then find the payment and apply the state change
 *
 * Step 2 is why replay is a no-op. A future edit that reorders these re-opens the
 * hole, which is what the assertion in supabase/tests/tenancy-isolation.sql pins.
 */
create or replace function public.record_payment_event(
  p_provider     text,
  p_external_id  text,
  p_event_type   text,
  p_provider_ref text,
  p_status       text,
  p_amount       bigint,
  p_payload      jsonb,
  p_fee          bigint default null,
  p_paid_at      timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id   uuid;
  v_payment    record;
  v_order      record;
  v_next       text;
  v_order_state text;
begin
  if p_provider is null or btrim(p_provider) = ''
     or p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'record_payment_event requires a provider and an external id'
      using errcode = 'check_violation';
  end if;

  -- ---- 1. De-duplicate, before anything is applied ----------------------
  insert into public.webhook_events (provider, external_id, event_type, payload)
  values (p_provider, p_external_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, external_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Already seen. Deliberately does not re-apply, re-log, or re-notify.
    return jsonb_build_object('outcome', 'duplicate', 'applied', false);
  end if;

  -- ---- 2. Find the payment this event is about --------------------------
  select * into v_payment
  from public.payments
  where provider = p_provider and provider_ref = p_provider_ref;

  if v_payment.id is null then
    update public.webhook_events
       set status = 'ignored',
           error_message = format('No payment with provider_ref %L', p_provider_ref),
           processed_at = now()
     where id = v_event_id;
    return jsonb_build_object('outcome', 'unmatched', 'applied', false);
  end if;

  update public.webhook_events
     set tenant_id = v_payment.tenant_id
   where id = v_event_id;

  select * into v_order from public.orders where id = v_payment.order_id;

  -- ---- 3. Decide the payment's new status -------------------------------
  /**
   * A short-pay is not a paid order.
   *
   * `p_amount` is what the provider says the buyer actually sent. Taking it as
   * proof of settlement without comparing it to what we charged would let a
   * one-centavo payment close a ₱1,500 order. The order-level rollup in
   * `sync_order_payment_status` does the comparison; here we only record the
   * payment honestly, including an amount that disagrees with the invoice.
   */
  v_next := case p_status
    when 'paid'    then 'paid'
    when 'expired' then 'expired'
    when 'failed'  then 'failed'
    else p_status
  end;

  if v_next not in ('pending', 'awaiting_action', 'paid', 'failed', 'expired',
                    'refunded', 'partially_refunded') then
    update public.webhook_events
       set status = 'ignored',
           error_message = format('Unhandled status %L', p_status),
           processed_at = now()
     where id = v_event_id;
    return jsonb_build_object('outcome', 'unhandled_status', 'applied', false);
  end if;

  -- A terminal payment does not move again. Providers do send late "expired" after
  -- a successful capture, and honouring that would un-pay a paid order.
  if v_payment.status = 'paid' and v_next <> 'refunded' and v_next <> 'partially_refunded' then
    update public.webhook_events
       set status = 'ignored',
           error_message = 'Payment already settled',
           processed_at = now()
     where id = v_event_id;
    return jsonb_build_object('outcome', 'already_settled', 'applied', false);
  end if;

  update public.payments
     set status     = v_next,
         amount_centavos = case when p_amount is null then amount_centavos else p_amount end,
         fee_centavos    = coalesce(p_fee, fee_centavos),
         paid_at    = case when v_next = 'paid' then coalesce(p_paid_at, now()) else paid_at end,
         raw        = coalesce(p_payload, raw),
         failure_reason = case when v_next in ('failed', 'expired')
                               then coalesce(p_payload ->> 'failure_code', p_event_type)
                               else failure_reason end
   where id = v_payment.id;

  -- ---- 4. Roll the order up ---------------------------------------------
  v_order_state := public.sync_order_payment_status(
    v_payment.order_id,
    format('%s webhook: %s', p_provider, coalesce(p_event_type, p_status)));

  update public.webhook_events
     set status = 'processed', processed_at = now()
   where id = v_event_id;

  return jsonb_build_object(
    'outcome',       'applied',
    'applied',       true,
    'paymentId',     v_payment.id,
    'orderId',       v_payment.order_id,
    'orderNumber',   v_order.order_number,
    'paymentStatus', v_next,
    'orderPaymentStatus', v_order_state
  );
end;
$$;

comment on function public.record_payment_event(text, text, text, text, text, bigint, jsonb, bigint, timestamptz) is
  'Idempotently record and apply a verified provider webhook. Service role only — anything that can call this can mark orders paid.';

/**
 * Resolve a webhook slug to the account that owns it.
 *
 * Returns the callback token so the Node handler can verify the delivery. Service
 * role only, for the obvious reason.
 */
create or replace function public.payment_account_for_webhook(p_slug text)
returns table (tenant_id uuid, provider text, callback_token text, is_enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select a.tenant_id, a.provider, a.callback_token, a.is_enabled
  from public.payment_accounts a
  where a.webhook_slug = p_slug;
$$;

-- ---------------------------------------------------------------------------
-- The outbound path
-- ---------------------------------------------------------------------------
/**
 * Open a payment for an order, ready for the provider call.
 *
 * Creates the `payments` row *before* the provider is contacted, so a crash between
 * the two leaves a visible pending payment rather than a silent gap. The provider
 * ref and checkout URL are filled in by `attach_payment_charge` once the call
 * returns.
 *
 * Authorised by the cart token the buyer already holds, because the buyer is
 * anonymous — the same boundary phase 6 established. A buyer may only open a payment
 * for an order that came from their own cart.
 */
create or replace function public.payment_open_for_token(
  p_token    text,
  p_order_id uuid,
  p_method   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   record;
  v_account record;
  v_payment_id uuid;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'Invalid cart token' using errcode = 'insufficient_privilege';
  end if;

  -- The order must belong to the cart this token opens. Taking an order id alone
  -- would make "open a payment" a capability anyone could aim at any order.
  select o.* into v_order
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where o.id = p_order_id and c.token = p_token;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'no_data_found';
  end if;

  if v_order.payment_status = 'paid' then
    raise exception 'That order is already paid'
      using errcode = 'check_violation', hint = 'already_paid';
  end if;

  if p_method not in ('gcash', 'maya', 'grabpay', 'card', 'qrph') then
    raise exception 'Unsupported online payment method %', p_method
      using errcode = 'check_violation';
  end if;

  select * into v_account
  from public.payment_accounts
  where tenant_id = v_order.tenant_id and provider = 'xendit';

  if v_account.id is null or not v_account.is_enabled then
    raise exception 'This store is not accepting online payments yet'
      using errcode = 'feature_not_supported', hint = 'online_unavailable';
  end if;

  -- Retire any earlier unfinished attempt for this order so the buyer does not end
  -- up with two live invoices for one order.
  update public.payments
     set status = 'expired'
   where order_id = p_order_id and status in ('pending', 'awaiting_action');

  insert into public.payments
    (tenant_id, order_id, provider, method, status, amount_centavos)
  values (v_order.tenant_id, p_order_id, 'xendit', p_method, 'pending',
          v_order.grand_total_centavos)
  returning id into v_payment_id;

  return jsonb_build_object(
    'paymentId',   v_payment_id,
    'orderId',     v_order.id,
    'orderNumber', v_order.order_number,
    'amount',      v_order.grand_total_centavos,
    'method',      p_method,
    'contactName', v_order.contact_name,
    'contactPhone',v_order.contact_phone,
    'contactEmail',v_order.contact_email
  );
end;
$$;

/**
 * Record what the provider returned for a payment we opened.
 *
 * Service role only: it is called by the server immediately after the provider call,
 * on the same request that created the payment.
 */
create or replace function public.attach_payment_charge(
  p_payment_id   uuid,
  p_provider_ref text,
  p_checkout_url text,
  p_status       text default 'awaiting_action',
  p_expires_at   timestamptz default null,
  p_raw          jsonb default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.payments
     set provider_ref = p_provider_ref,
         checkout_url = p_checkout_url,
         status       = p_status,
         expires_at   = p_expires_at,
         raw          = coalesce(p_raw, raw)
   where id = p_payment_id;
$$;

/**
 * The buyer's view of their own payment, by cart token.
 *
 * Lets the confirmation page say "waiting for your GCash payment" and offer the
 * checkout link again, without granting a buyer any table access.
 */
create or replace function public.payment_status_for_token(
  p_token    text,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   record;
  v_payment record;
begin
  select o.* into v_order
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where o.id = p_order_id and c.token = p_token;

  if v_order.id is null then
    return null;
  end if;

  select * into v_payment
  from public.payments
  where order_id = p_order_id
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'orderNumber',   v_order.order_number,
    'paymentStatus', v_order.payment_status,
    'method',        v_order.payment_method,
    'grandTotal',    v_order.grand_total_centavos,
    -- The checkout URL is the buyer's own, and only while it is still usable.
    'checkoutUrl',   case when v_payment.status in ('pending', 'awaiting_action')
                          then v_payment.checkout_url end,
    'attemptStatus', v_payment.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Seller-recorded payments
-- ---------------------------------------------------------------------------
/**
 * A payment that happened outside any provider: a bank transfer, or a GCash send
 * with a screenshot.
 *
 * This is how most PH social sellers actually get paid today, so it is a first-class
 * path rather than an afterthought. Staff-level, because recording money as received
 * is an operational act a packer legitimately performs.
 */
create or replace function public.record_manual_payment(
  p_order_id   uuid,
  p_method     text,
  p_amount     bigint,
  p_proof_path text default null,
  p_note       text default null,
  p_paid_at    timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order      record;
  v_payment_id uuid;
  v_state      text;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'no_data_found';
  end if;

  if not public.has_tenant_role(v_order.tenant_id, 'staff') then
    raise exception 'Not allowed to record payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A recorded payment needs a positive amount'
      using errcode = 'check_violation';
  end if;

  if p_method not in ('bank', 'gcash', 'maya', 'grabpay', 'card', 'qrph') then
    raise exception 'Unsupported manual payment method %', p_method
      using errcode = 'check_violation';
  end if;

  insert into public.payments
    (tenant_id, order_id, provider, method, status, amount_centavos,
     proof_path, proof_note, paid_at)
  values (v_order.tenant_id, p_order_id, 'manual', p_method, 'paid', p_amount,
          p_proof_path, p_note, coalesce(p_paid_at, now()))
  returning id into v_payment_id;

  v_state := public.sync_order_payment_status(
    p_order_id, coalesce(p_note, format('Recorded by hand (%s)', p_method)));

  return jsonb_build_object(
    'paymentId', v_payment_id, 'orderPaymentStatus', v_state);
end;
$$;

/**
 * COD collected and remitted.
 *
 * COD is a payment method with a lifecycle, not the absence of payment: the rider
 * collects, the courier remits days later, and the seller reconciles against a
 * statement. The order is `confirmed` and `unpaid` from placement until this is
 * called — which is exactly the state phase 12's reconciliation reads.
 */
create or replace function public.record_cod_remittance(
  p_order_id uuid,
  p_amount   bigint default null,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order      record;
  v_payment_id uuid;
  v_state      text;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'no_data_found';
  end if;

  if not public.has_tenant_role(v_order.tenant_id, 'staff') then
    raise exception 'Not allowed to record payments for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if v_order.payment_method <> 'cod' then
    raise exception 'That order is not a COD order'
      using errcode = 'check_violation', hint = 'not_cod';
  end if;

  insert into public.payments
    (tenant_id, order_id, provider, method, status, amount_centavos, paid_at, proof_note)
  values (v_order.tenant_id, p_order_id, 'cod', 'cod', 'paid',
          coalesce(p_amount, v_order.grand_total_centavos), now(), p_note)
  returning id into v_payment_id;

  v_state := public.sync_order_payment_status(
    p_order_id, coalesce(p_note, 'COD remitted'));

  return jsonb_build_object(
    'paymentId', v_payment_id, 'orderPaymentStatus', v_state);
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------
/**
 * Refund some or all of a payment.
 *
 * Admin-level, unlike recording a payment: giving money back is not a packing-desk
 * decision. The `payments.refunded_centavos` running total is what
 * `sync_order_payment_status` reads, and the CHECK stops it exceeding the payment.
 *
 * For a provider payment this records our side; the actual provider call is made by
 * the server, which then confirms via `settle_refund`. Recording first means a
 * refund that fails at the provider is visible as `pending` rather than lost.
 */
create or replace function public.open_refund(
  p_payment_id uuid,
  p_amount     bigint,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment record;
  v_refund_id uuid;
begin
  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'no_data_found';
  end if;

  if not public.has_tenant_role(v_payment.tenant_id, 'admin') then
    raise exception 'Only an admin can refund a payment'
      using errcode = 'insufficient_privilege';
  end if;

  if v_payment.status not in ('paid', 'partially_refunded') then
    raise exception 'Only a settled payment can be refunded'
      using errcode = 'check_violation', hint = 'not_settled';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A refund needs a positive amount' using errcode = 'check_violation';
  end if;

  if p_amount > (v_payment.amount_centavos::bigint - v_payment.refunded_centavos::bigint) then
    raise exception 'That is more than is left to refund'
      using errcode = 'check_violation', hint = 'over_refund';
  end if;

  insert into public.payment_refunds
    (tenant_id, payment_id, amount_centavos, reason, status, actor_id)
  values (v_payment.tenant_id, p_payment_id, p_amount, p_reason, 'pending', auth.uid())
  returning id into v_refund_id;

  return jsonb_build_object('refundId', v_refund_id, 'paymentId', p_payment_id);
end;
$$;

/**
 * Confirm or fail a refund, and roll the order up.
 *
 * Separate from `open_refund` because the provider answers asynchronously, and
 * because a manual refund (the seller sent the money back themselves) settles with
 * no provider involved at all.
 */
create or replace function public.settle_refund(
  p_refund_id    uuid,
  p_status       text,
  p_provider_ref text default null,
  p_raw          jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund  record;
  v_payment record;
  v_total   bigint;
  v_state   text;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if v_refund.id is null then
    raise exception 'Refund not found' using errcode = 'no_data_found';
  end if;

  if p_status not in ('succeeded', 'failed') then
    raise exception 'A refund settles as succeeded or failed' using errcode = 'check_violation';
  end if;

  -- Service role skips the role check (the webhook path has no user); a human must
  -- be an admin.
  if auth.uid() is not null and not public.has_tenant_role(v_refund.tenant_id, 'admin') then
    raise exception 'Only an admin can settle a refund' using errcode = 'insufficient_privilege';
  end if;

  if v_refund.status <> 'pending' then
    return jsonb_build_object('outcome', 'already_settled', 'applied', false);
  end if;

  update public.payment_refunds
     set status = p_status, provider_ref = p_provider_ref, raw = coalesce(p_raw, raw)
   where id = p_refund_id;

  if p_status = 'failed' then
    return jsonb_build_object('outcome', 'failed', 'applied', true);
  end if;

  select coalesce(sum(amount_centavos::bigint), 0) into v_total
  from public.payment_refunds
  where payment_id = v_refund.payment_id and status = 'succeeded';

  select * into v_payment from public.payments where id = v_refund.payment_id;

  update public.payments
     set refunded_centavos = v_total,
         status = case when v_total >= v_payment.amount_centavos::bigint
                       then 'refunded' else 'partially_refunded' end
   where id = v_refund.payment_id;

  v_state := public.sync_order_payment_status(
    v_payment.order_id, format('Refunded %s', v_refund.reason));

  return jsonb_build_object('outcome', 'succeeded', 'applied', true,
                            'orderPaymentStatus', v_state);
end;
$$;

-- ---------------------------------------------------------------------------
-- checkout_place_order: online methods are live now
-- ---------------------------------------------------------------------------
/**
 * Phase 6 refused every method but COD, on the grounds that accepting an online
 * method would create an order that could never be paid. Phase 8 is the thing that
 * made that false, so the refusal is replaced by a real check: online is available
 * when the tenant has an enabled payment account.
 *
 * Only the payment-method gate changes. The rest of the function — pricing through
 * `cart_pricing`, PSGC address validation, the sorted advisory locks — is phase 6
 * and 7 code and is deliberately untouched.
 */
create or replace function public.checkout_online_available(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payment_accounts
    where tenant_id = p_tenant_id and provider = 'xendit' and is_enabled
  );
$$;

/**
 * The provider credentials behind a payment, for the server's outbound call.
 *
 * Service role only. This is the one function that returns a secret key, and it
 * exists because the alternative — a platform-wide key — would put every seller's
 * money through one account. Revoked from both client roles explicitly below.
 *
 * Keyed on the payment rather than the tenant on purpose: the caller is the
 * checkout route, which has just opened a payment by cart token and has no
 * legitimate way to know a tenant id. Taking a tenant id here would have meant
 * putting one in a buyer-facing payload to get it there.
 */
create or replace function public.payment_credentials_for_payment(p_payment_id uuid)
returns table (tenant_id uuid, secret_key text, callback_token text, is_live boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select a.tenant_id, a.secret_key, a.callback_token, a.is_live
  from public.payments p
    join public.payment_accounts a
      on a.tenant_id = p.tenant_id and a.provider = p.provider
  where p.id = p_payment_id and a.is_enabled;
$$;

/**
 * Record one attempt at an external call.
 *
 * Hard rule 7 says every external API call is wrapped in an idempotency key plus
 * retry with backoff *and logged to `integration_logs`*. This is the logging half.
 *
 * The unique `(tenant_id, idempotency_key)` means a retried call updates its row
 * rather than creating a second one, so the table reads as one row per logical
 * operation with the attempt count on it — which is the shape you want when asking
 * "how often is Xendit failing us?".
 */
create or replace function public.log_integration_attempt(
  p_tenant_id       uuid,
  p_provider        text,
  p_operation       text,
  p_idempotency_key text,
  p_status          text,
  p_attempt         int default 1,
  p_error_code      text default null,
  p_error_message   text default null,
  p_duration_ms     int default null,
  p_http_status     int default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.integration_logs
    (tenant_id, provider, operation, idempotency_key, status, attempt,
     error_code, error_message, duration_ms, http_status)
  values
    (p_tenant_id, p_provider, p_operation, p_idempotency_key, p_status, p_attempt,
     p_error_code, p_error_message, p_duration_ms, p_http_status)
  on conflict (tenant_id, idempotency_key) do update
    set status        = excluded.status,
        attempt       = greatest(public.integration_logs.attempt, excluded.attempt),
        error_code    = excluded.error_code,
        error_message = excluded.error_message,
        duration_ms   = excluded.duration_ms,
        http_status   = excluded.http_status;
$$;

/**
 * Which online methods a storefront can actually take, by slug or custom domain.
 *
 * Anon-callable, and deliberately narrow: it answers "what can I offer this buyer"
 * with a list of method names and nothing else. No account id, no key state, no
 * hint about whether the store is on live or test keys.
 *
 * Returns an empty array — not an error — for a store with no payment account, so
 * the checkout page renders COD alone rather than an error state. The methods are
 * intersected with what the tenant chose in `payments.methods`, so switching one
 * off is a settings change rather than a code change.
 */
create or replace function public.storefront_payment_methods(
  p_slug   text default null,
  p_domain text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(m.value order by m.ordinality)
    from public.payment_accounts a
      join public.tenant_settings s
        on s.tenant_id = a.tenant_id and s.key = 'payments.methods'
      cross join lateral jsonb_array_elements_text(s.value) with ordinality as m(value, ordinality)
    where a.tenant_id = public.storefront_tenant_id(p_slug, p_domain)
      and a.provider = 'xendit'
      and a.is_enabled
      and m.value in ('gcash', 'maya', 'grabpay', 'qrph', 'card')
  ), '[]'::jsonb);
$$;

grant execute on function public.storefront_payment_methods(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.payment_accounts enable row level security;
alter table public.payment_accounts force  row level security;
alter table public.payments         enable row level security;
alter table public.payments         force  row level security;
alter table public.payment_refunds  enable row level security;
alter table public.payment_refunds  force  row level security;
alter table public.webhook_events   enable row level security;
alter table public.webhook_events   force  row level security;

-- Credentials are admin-only even to read the non-secret columns: knowing whether a
-- store is on live keys is not packer business.
create policy "Admins read payment accounts" on public.payment_accounts for select to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins add payment accounts" on public.payment_accounts for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins update payment accounts" on public.payment_accounts for update to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'))
  with check (public.has_tenant_role(tenant_id, 'admin'));
create policy "Admins delete payment accounts" on public.payment_accounts for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

-- Payments are member-readable: seeing whether an order is paid is everyone's job.
create policy "Members read payments" on public.payments for select to authenticated
  using (public.is_tenant_member(tenant_id));
-- Writes go through the SECURITY DEFINER functions above, which apply the role
-- checks and keep the order rollup consistent. No direct insert/update policy: a
-- hand-written `update payments set status = 'paid'` would leave the order behind.

create policy "Members read refunds" on public.payment_refunds for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Webhook events are an operator/seller diagnostic, readable by admins.
create policy "Admins read webhook events" on public.webhook_events for select to authenticated
  using (tenant_id is not null and public.has_tenant_role(tenant_id, 'admin'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
/**
 * The column list here is the security boundary, not the policies.
 *
 * `secret_key` and `callback_token` are absent from every grant. RLS is row-level,
 * so no policy can withhold a column — omitting them from the GRANT is the only way
 * to make them unreadable, exactly as `carts.token` is in phase 6. A seller who
 * could read their own callback token could forge webhooks against their own store,
 * which sounds harmless until you remember COD reconciliation and refunds run off
 * the same statuses.
 */
grant select (id, tenant_id, provider, webhook_slug, is_live, is_enabled,
              connected_at, created_at, updated_at)
  on public.payment_accounts to authenticated;
grant insert, update, delete on public.payment_accounts to authenticated;
grant select on public.payment_accounts_safe to authenticated;

grant select on public.payments        to authenticated;
grant select on public.payment_refunds to authenticated;
grant select on public.webhook_events  to authenticated;

-- Seller-facing operations.
grant execute on function public.record_manual_payment(uuid, text, bigint, text, text, timestamptz) to authenticated;
grant execute on function public.record_cod_remittance(uuid, bigint, text) to authenticated;
grant execute on function public.open_refund(uuid, bigint, text) to authenticated;
grant execute on function public.settle_refund(uuid, text, text, jsonb) to authenticated;
grant execute on function public.checkout_online_available(uuid) to authenticated, anon;

-- Buyer-facing, authorised by the cart token.
grant execute on function public.payment_open_for_token(text, uuid, text) to anon, authenticated;
grant execute on function public.payment_status_for_token(text, uuid) to anon, authenticated;

/**
 * Service-role only. Not a stylistic choice.
 *
 * `record_payment_event` marks orders paid. `attach_payment_charge` sets the
 * provider ref a webhook is later matched on, so writing to it is enough to
 * redirect someone else's payment onto your order. `payment_account_for_webhook`
 * and `payment_credentials_for_payment` return secrets.
 *
 * **`from public`, not `from anon, authenticated`.** Postgres grants EXECUTE on
 * every new function to PUBLIC by default, and revoking from a specific role does
 * not remove a privilege that role holds *through* PUBLIC — the revoke succeeds,
 * changes nothing, and reports no error. Written the wrong way first, and the
 * result was that `record_payment_event` was callable by `anon`: anyone who could
 * observe an invoice id could settle someone else's order. `\dp` showed `=X/postgres`
 * — the empty grantee is PUBLIC — and the tenancy suite caught it on the first run.
 *
 * The service role is unaffected: it has BYPASSRLS and is a superuser-equivalent in
 * Supabase, so it does not need an explicit grant.
 */
revoke all on function public.record_payment_event(text, text, text, text, text, bigint, jsonb, bigint, timestamptz) from public;
revoke all on function public.attach_payment_charge(uuid, text, text, text, timestamptz, jsonb) from public;
revoke all on function public.payment_account_for_webhook(text) from public;
revoke all on function public.sync_order_payment_status(uuid, text) from public;
revoke all on function public.payment_credentials_for_payment(uuid) from public;
revoke all on function public.log_integration_attempt(uuid, text, text, text, text, int, text, text, int, int) from public;

-- ---------------------------------------------------------------------------
-- Private storage for payment proof
-- ---------------------------------------------------------------------------
/**
 * A GCash receipt is not a product photo.
 *
 * It carries a buyer's name, the amount, and a reference number, so it goes in a
 * **private** bucket. The public `tenant-public` bucket would make each one readable
 * by URL alone, and object names derived from order numbers are guessable enough
 * that obscurity is not a control.
 */
insert into storage.buckets (id, name)
values ('tenant-private', 'tenant-private')
on conflict (id) do nothing;

/**
 * `public`, `file_size_limit` and `allowed_mime_types` exist only on newer
 * storage schema revisions, so they are set dynamically — the same shape phase 2
 * uses for `tenant-public`, and for the same reason.
 *
 * The bare `supabase/postgres` image CI pins ships the *base* storage schema; the
 * extra columns are added by the storage service at boot, which CI does not run.
 * So the straight `insert … (id, name, public, …)` this migration used to carry
 * worked on every developer's local stack and failed on the twelfth migration in
 * CI — where it aborted the run, which is why nothing after it was ever verified
 * there either.
 *
 * Edited in place rather than repaired by a later migration, which is the one
 * situation where that is the only option: the failure happens *during* this
 * file, so no migration after it can ever run to fix it. It is safe because the
 * two forms produce identical state wherever the old one worked.
 */
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets'
               and column_name = 'public') then
    -- Private, unlike `tenant-public`: these are proofs of payment.
    execute $q$ update storage.buckets set public = false where id = 'tenant-private' $q$;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets'
               and column_name = 'file_size_limit') then
    -- 5 MB. A GCash screenshot from a phone is bigger than a logo.
    execute $q$ update storage.buckets set file_size_limit = 5242880
                where id = 'tenant-private' $q$;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets'
               and column_name = 'allowed_mime_types') then
    execute $q$ update storage.buckets
                set allowed_mime_types =
                  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
                where id = 'tenant-private' $q$;
  end if;
end;
$$;

-- Path convention: {tenant_id}/payments/{order_id}/{filename}
create policy "Members read their tenant's private files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'tenant-private'
    and public.is_tenant_member(((storage.foldername(name))[1])::uuid)
  );

create policy "Staff upload their tenant's private files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenant-private'
    and public.has_tenant_role(((storage.foldername(name))[1])::uuid, 'staff')
  );

create policy "Staff replace their tenant's private files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'tenant-private'
    and public.has_tenant_role(((storage.foldername(name))[1])::uuid, 'staff')
  );

create policy "Admins delete their tenant's private files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'tenant-private'
    and public.has_tenant_role(((storage.foldername(name))[1])::uuid, 'admin')
  );

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
-- Seeded per tenant so the payments screen has something to read on day one.
-- Registered in src/lib/settings/keys.ts, which is the compensating control for a
-- key/value table where nothing stops a typo.
insert into public.tenant_settings (tenant_id, key, value)
select t.id, k.key, k.value
from public.tenants t
cross join (values
  ('payments.online_enabled', 'false'::jsonb),
  ('payments.methods', '["gcash","maya","grabpay","qrph","card"]'::jsonb)
) as k(key, value)
on conflict (tenant_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- checkout_place_order — the COD-only gate becomes a real capability check
-- ---------------------------------------------------------------------------
/**
 * Reproduced in full because `create or replace function` has no way to patch a
 * body. Only the payment-method gate differs from the phase-7 version: everything
 * else — pricing through `cart_pricing`, PSGC address validation, the sorted
 * advisory locks — is untouched, and this text was generated from the live function
 * so the untouched parts are byte-identical rather than retyped.
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

  update public.customers
     set total_orders = total_orders + 1,
         total_spent_centavos = total_spent_centavos + (v_pricing ->> 'grandTotal')::bigint
   where id = v_customer_id;

  return public.order_receipt(v_order_id);
end;
$function$;

grant execute on function public.checkout_place_order(text, text, text, jsonb, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- New tenants get the payments.methods default too
-- ---------------------------------------------------------------------------
/**
 * The one-time backfill above covers stores that already existed when this
 * migration ran. Without this, every store created *after* it would have no
 * `payments.methods` row — and `storefront_payment_methods` would return an empty
 * list, so a seller who connected Xendit correctly would still see COD-only at
 * checkout with nothing to indicate why.
 *
 * Found by connecting an account on a freshly created store and getting `[]` back.
 * Reproduced in full from the live definition; only the new key is added.
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

  -- Order numbering starts at 1 for every tenant.
  insert into public.order_counters (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;

  return new;
end;
$function$;