/**
 * Phase 20 — Hardening & launch.
 *
 * The done-when is "a fresh signup can go live and process a real paid order
 * with zero support contact", which sounds like an onboarding sentence and is
 * mostly a *hardening* one: the reason a new seller messages support is that
 * something broke, or something was refused without saying why, or they were
 * asked for something nobody explained. So this migration is about the three
 * things that break quietly.
 *
 * ## Rate limiting, and why it fails open
 *
 * Every public endpoint here is reachable without an account: a cart token, an
 * order number, a short-link slug, a webhook URL. None of them can be protected
 * by asking who the caller is, so they are protected by asking how often.
 *
 * The counters live in Postgres rather than in the Node process because there is
 * more than one process and a limit that resets on deploy is not a limit. And
 * `rate_limit_hit()` is called by a server that **treats any error as allow** —
 * a rate limiter that takes the storefront down when the database hiccups has
 * cost the seller more than the abuse it was written for.
 *
 * ## Consent is for marketing, not for the order
 *
 * The tempting reading of "consent capture at checkout" is a checkbox the buyer
 * must tick before they can pay. That is both bad law and bad product. Under the
 * Data Privacy Act, processing an order is *necessary for the contract* the buyer
 * is entering into — the lawful basis is the purchase itself, and asking for
 * consent implies it could be withheld, which it cannot be if the buyer wants
 * their parcel. What genuinely needs consent is the thing that is **not**
 * necessary for the contract: sending them a payday broadcast three weeks later.
 *
 * So the checkbox records a marketing grant with the policy version, and the
 * order does not depend on it. That also keeps phase 19's rule intact: a buyer's
 * checkout must never fail for a reason the buyer cannot fix.
 *
 * The *send* path is where it bites. `broadcast_recipients` refuses a customer
 * who has withdrawn — a trigger, not a filter in one function, so it holds for
 * the abandoned-cart sequence and the repeat-buyer nudge as well as for a
 * broadcast, and for anything phase 21 adds.
 *
 * ## Deletion that a seller can legally honour
 *
 * "Delete my data" and "keep your sales records" are both legal obligations, and
 * they are in tension. So a deletion request is served by **erasure, not by
 * DELETE**: the person is removed from the row and the transaction stays. Name,
 * phone, email, PSID, notes and the street address go; the city, the totals, the
 * dates and the line items remain, because those are the seller's books and
 * carry no person in them.
 *
 * Deleting the orders outright would be the easy implementation and would leave
 * the seller unable to answer BIR, unable to reconcile a courier statement, and
 * with a revenue figure that changed retroactively.
 */

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------
/**
 * Fixed-window counters, keyed by whatever the caller cannot cheaply vary.
 *
 * Fixed rather than sliding, deliberately. A sliding window needs a row per
 * request to be exact, and the exactness buys nothing here: the worst case of a
 * fixed window is that an attacker who lands exactly on a boundary gets 2× the
 * limit in one burst, which for "30 checkouts a minute from one cart token" is
 * 60 checkouts and still not an outage. The cost of the sliding version is a
 * write-heavy table on the buyer's own path, which is the one place this
 * codebase has a latency budget it is not allowed to spend.
 *
 * RLS on, no policy, no grants. A counter table a client can read is a client
 * that can tell how close it is to the limit; one it can write is not a limit.
 */
create table public.rate_limit_counters (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,

  primary key (bucket, window_start)
);

create index rate_limit_counters_window_idx on public.rate_limit_counters (window_start);

alter table public.rate_limit_counters enable row level security;
alter table public.rate_limit_counters force  row level security;

/**
 * Count one hit and say whether it is allowed.
 *
 * Returns `{allowed, hits, limit, retryAfter}`. The caller decides what to do
 * with a `false` — the storefront answers 429 with `Retry-After`, the webhook
 * routes answer 429 so the provider retries rather than dropping the delivery.
 *
 * `p_bucket` is the whole of the key, composed by the caller: `checkout:<token>`,
 * `track:<ip>`, `otp:<email>`. Composing it here would mean this function had to
 * know every endpoint, and adding one would mean a migration.
 *
 * Service role only. It is a write, and a client that can call it can exhaust
 * somebody else's budget by guessing their bucket.
 */
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit  int,
  p_window_seconds int default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_hits  int;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'A rate limit needs a positive limit and window'
      using errcode = 'check_violation';
  end if;

  -- Floor the clock to the window, so every process in the fleet agrees on which
  -- bucket "now" belongs to without coordinating.
  v_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_counters (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update
    set hits = public.rate_limit_counters.hits + 1
  returning hits into v_hits;

  return jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'hits', v_hits,
    'limit', p_limit,
    'retryAfter', greatest(1, ceil(extract(epoch from (v_start
      + make_interval(secs => p_window_seconds) - clock_timestamp())))::int));
end;
$$;

/**
 * Drop windows nobody can still be inside.
 *
 * Called on a timer by the server rather than by a trigger on every insert: a
 * sweep on the hot path is the buyer paying for our housekeeping.
 */
create or replace function public.rate_limit_sweep(p_older_than interval default interval '1 hour')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_n int;
begin
  with gone as (
    delete from public.rate_limit_counters
    where window_start < now() - p_older_than
    returning 1)
  select count(*) into v_n from gone;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- One cross-tenant child that was representable, and should not have been
-- ---------------------------------------------------------------------------
/**
 * Found by the per-table sweep this phase adds, not by anybody reading the file.
 *
 * `sms_credit_entries.sms_log_id` referenced `sms_logs (id)` — a plain key — so a
 * ledger entry in one store could point at another store's message. Nothing
 * leaked: the read path joins through `sms_logs`, which has its own policy, so a
 * seller following the link got nothing. But "the row cannot be written" is a
 * stronger statement than "the row cannot be read", and it is the one CLAUDE.md's
 * composite-FK rule exists to make.
 *
 * That is the argument for the sweep. This is the only one it found in twenty
 * phases, and it was found by asking every table the question rather than by
 * remembering to ask this one.
 */
alter table public.sms_logs
  add constraint sms_logs_tenant_id_id_key unique (tenant_id, id);

alter table public.sms_credit_entries
  drop constraint sms_credit_entries_sms_log_id_fkey;

alter table public.sms_credit_entries
  add constraint sms_credit_entries_sms_log_fkey
  foreign key (tenant_id, sms_log_id)
  references public.sms_logs (tenant_id, id) on delete set null (sms_log_id);

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------
/**
 * What a buyer agreed to, when, and against which version of the policy.
 *
 * Append-only by construction: a withdrawal is a *new row*, not an update of the
 * old one. "They consented on the 3rd and withdrew on the 9th" is the fact a
 * regulator asks about, and a table that overwrites the grant can only answer
 * the second half of it.
 *
 * `evidence` carries what the server saw — a hash of the IP, the user agent, the
 * surface. Hashed rather than stored: an IP is personal data under the DPA, and a
 * consent log that is itself a privacy problem is a poor joke.
 */
create table public.privacy_consents (
  id        uuid not null default gen_random_uuid(),
  /**
   * The ordering, and it is not `created_at`.
   *
   * `now()` is the *transaction* timestamp, so two rows written together carry
   * the same one and the tiebreak falls to a random uuid — which means "the most
   * recent row wins" resolves to a coin flip about half the time. The SMS credit
   * ledger shipped exactly this bug in phase 11 and it presented as flakiness
   * rather than as failure, which is why it survived a green run.
   *
   * A consent log deciding the wrong way is a message sent to somebody who
   * withdrew, so this one is monotonic by construction.
   */
  seq bigint generated always as identity,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid,

  /** What the person agreed to. `marketing` is the only one that gates anything. */
  purpose text not null default 'marketing'
    check (purpose in ('marketing', 'risk_network', 'analytics')),
  granted boolean not null,

  /** Which text they were shown. A grant against an unknown policy is not one. */
  policy_version text not null,
  /** Where it happened: the checkout form, the seller's screen, an SMS reply. */
  source text not null default 'checkout'
    check (source in ('checkout', 'seller', 'sms_reply', 'import', 'migration')),

  evidence jsonb not null default '{}'::jsonb,
  order_id uuid,
  created_at timestamptz not null default now(),

  primary key (id),
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null (customer_id)
);

create unique index privacy_consents_customer_idx
  on public.privacy_consents (tenant_id, customer_id, purpose, seq desc);

/**
 * May this store send this customer marketing?
 *
 * **Opt-out, not opt-in, and that is a decision worth defending.** Every customer
 * in this table got there by buying something, which is a relationship, and the
 * NPC's own guidance treats an existing customer relationship as a basis for
 * related communication. Requiring a fresh opt-in would also have silently
 * emptied every seller's audience on the morning this deployed — sixteen phases
 * of customers, none of whom had ever been shown a checkbox.
 *
 * So a *withdrawal* is what stops a send, and it is absolute: the most recent row
 * for the purpose wins, and there is no path that ignores it.
 *
 * Transactional messages are not affected and must not be. "Your parcel is out
 * for delivery" is the contract, not marketing, and a buyer who unsubscribed from
 * payday blasts has not asked to stop hearing where their order is.
 */
create or replace function public.customer_may_market(p_tenant_id uuid, p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.granted
    from public.privacy_consents c
    where c.tenant_id = p_tenant_id
      and c.customer_id = p_customer_id
      and c.purpose = 'marketing'
    order by c.seq desc
    limit 1), true);
$$;

/**
 * A withdrawn customer cannot be added to a send. Ever, by any path.
 *
 * A trigger on the recipient row rather than a `where` clause inside
 * `broadcast_start`, for the reason phase 19's feature gates are triggers: the
 * abandoned-cart sequence and the repeat-buyer nudge write recipients too, and so
 * will whatever comes next. One rule, one place, and it holds inside a
 * `SECURITY DEFINER` function.
 *
 * `channel = 'none'` is allowed through: that row exists precisely to record that
 * nothing was sent, and refusing it would lose the reason.
 */
create or replace function public.enforce_marketing_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel = 'none' or new.customer_id is null then return new; end if;
  if public.customer_may_market(new.tenant_id, new.customer_id) then return new; end if;

  raise exception 'This customer has opted out of marketing messages'
    using errcode = 'check_violation', hint = 'marketing_opt_out';
end;
$$;

create trigger broadcast_recipients_consent
  before insert on public.broadcast_recipients
  for each row execute function public.enforce_marketing_consent();

/**
 * Record what the buyer ticked, from the checkout form.
 *
 * Called by the storefront's checkout handler with the cart token, so the person
 * is identified the same way everything else on that surface identifies them —
 * and so a caller cannot record a grant on behalf of somebody else's customer.
 *
 * Called *after* the order is placed, because until then there is no customer row
 * to attach it to. That ordering is safe precisely because the order does not
 * depend on it: see the file header.
 */
create or replace function public.record_checkout_consent(
  p_token   text,
  p_order_id uuid,
  p_granted boolean,
  p_policy_version text,
  p_evidence jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select o.* into v_order
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where o.id = p_order_id and c.token = p_token;

  if v_order.id is null then return false; end if;
  if v_order.customer_id is null then return false; end if;

  insert into public.privacy_consents
    (tenant_id, customer_id, purpose, granted, policy_version, source, evidence, order_id)
  values (v_order.tenant_id, v_order.customer_id, 'marketing', p_granted,
          btrim(p_policy_version), 'checkout', coalesce(p_evidence, '{}'::jsonb), v_order.id);
  return true;
end;
$$;

/** The seller records a withdrawal — a phone call, an SMS reply, a message. */
create or replace function public.set_marketing_consent(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_granted boolean,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.customers
                 where id = p_customer_id and tenant_id = p_tenant_id) then
    raise exception 'No such customer' using errcode = 'no_data_found';
  end if;

  insert into public.privacy_consents
    (tenant_id, customer_id, purpose, granted, policy_version, source, evidence)
  values (p_tenant_id, p_customer_id, 'marketing', p_granted,
          public.privacy_policy_version(), 'seller',
          jsonb_build_object('note', p_note, 'by', auth.uid()));
  return p_granted;
end;
$$;

/**
 * The policy version a grant is recorded against.
 *
 * A function rather than a literal in five call sites, because the day the policy
 * text changes is the day every one of those has to move together — and the one
 * that does not move records agreement to a document nobody was shown.
 */
create or replace function public.privacy_policy_version()
returns text
language sql
immutable
as $$ select '2026-08-01'::text; $$;

-- ---------------------------------------------------------------------------
-- Data subject requests
-- ---------------------------------------------------------------------------
/**
 * "Send me my data" and "delete me", with a clock on them.
 *
 * The deadline is a column and not a convention. The DPA gives a data subject a
 * right to access and to erasure, and the NPC expects a controller to act within
 * a reasonable period — fifteen days is the figure its own guidance uses, so that
 * is the default here and it is *stored on the row*, because a deadline that
 * lives in someone's head is a deadline that is discovered after it passed.
 *
 * The request is keyed on a phone number rather than on a customer id: the person
 * asking has a phone number, not a uuid, and may well appear as two rows if they
 * ordered twice under different spellings of their name.
 */
create table public.data_subject_requests (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  kind text not null check (kind in ('export', 'deletion', 'correction')),
  /** Normalised at the boundary, like everywhere else a PH number is stored. */
  subject_phone text not null check (subject_phone ~ '^\+63[0-9]{9,10}$'),
  subject_email text,
  note text,

  status text not null default 'open'
    check (status in ('open', 'served', 'refused', 'withdrawn')),
  refused_reason text,

  requested_at timestamptz not null default now(),
  due_at       timestamptz not null default now() + interval '15 days',
  served_at    timestamptz,
  served_by    uuid references public.profiles (id) on delete set null,
  /** What was actually done, so "we deleted them" is checkable a year later. */
  outcome jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id)
);

create index data_subject_requests_open_idx
  on public.data_subject_requests (tenant_id, due_at)
  where status = 'open';

create trigger data_subject_requests_set_updated_at
  before update on public.data_subject_requests
  for each row execute function public.set_updated_at();

/**
 * Everything one person's phone number touches in one store.
 *
 * A real export, not a summary: the customer row, every order with its items, the
 * addresses, the consent history, and the messages. A "data export" that omits
 * the messages because they live in another table is the kind of answer that gets
 * a controller in trouble, so this reads every table that carries the person.
 *
 * Staff-only and tenant-scoped — the export is the most concentrated piece of
 * personal data the product can produce, and handing it to the wrong caller would
 * be the breach the rest of this file exists to prevent.
 */
create or replace function public.dsr_export(p_tenant_id uuid, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_digits text := public.ph_national_digits(p_phone);
  v_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select array_agg(id) into v_ids
  from public.customers
  where tenant_id = p_tenant_id and public.ph_national_digits(phone) = v_digits;

  return jsonb_build_object(
    'exportedAt', now(),
    'store', (select jsonb_build_object('name', name, 'slug', slug)
              from public.tenants where id = p_tenant_id),
    'policyVersion', public.privacy_policy_version(),
    'customers', coalesce((
      select jsonb_agg(to_jsonb(c) - 'tenant_id')
      from public.customers c
      where c.tenant_id = p_tenant_id and c.id = any(coalesce(v_ids, '{}'::uuid[]))), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'orderNumber', o.order_number,
        'placedAt', o.placed_at,
        'status', o.fulfillment_status,
        'paymentStatus', o.payment_status,
        'totalCentavos', o.grand_total_centavos,
        'shippingAddress', o.shipping_address,
        'contactName', o.contact_name,
        'contactPhone', o.contact_phone,
        'items', (select jsonb_agg(jsonb_build_object(
                    'productName', i.product_name, 'sku', i.sku, 'qty', i.qty,
                    'unitPriceCentavos', i.unit_price_centavos))
                  from public.order_items i where i.order_id = o.id))
        order by o.placed_at)
      from public.orders o
      where o.tenant_id = p_tenant_id
        and public.ph_national_digits(o.contact_phone) = v_digits), '[]'::jsonb),
    'addresses', coalesce((
      select jsonb_agg(to_jsonb(a) - 'tenant_id' - 'customer_id')
      from public.customer_addresses a
      where a.tenant_id = p_tenant_id
        and a.customer_id = any(coalesce(v_ids, '{}'::uuid[]))), '[]'::jsonb),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purpose', c.purpose, 'granted', c.granted,
        'policyVersion', c.policy_version, 'source', c.source, 'at', c.created_at)
        order by c.created_at)
      from public.privacy_consents c
      where c.tenant_id = p_tenant_id
        and c.customer_id = any(coalesce(v_ids, '{}'::uuid[]))), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'direction', m.direction, 'body', m.body, 'at', m.created_at)
        order by m.created_at)
      from public.messages m
        join public.message_threads t on t.id = m.thread_id
      where t.tenant_id = p_tenant_id
        and t.customer_id = any(coalesce(v_ids, '{}'::uuid[]))), '[]'::jsonb)
  );
end;
$$;

/**
 * Serve a deletion request by erasing the person and keeping the transaction.
 *
 * The two obligations pull in opposite directions — a buyer may require their
 * personal data be removed, and a seller is required to keep sales records — so
 * this resolves them rather than picking one. What goes: name, phone, email,
 * PSID, notes, street address, and every message. What stays: the order, its
 * total, its date, its line items and its destination *city*, because those are
 * the seller's books and their courier reconciliation and they carry no person.
 *
 * The phone is replaced with a deterministic per-tenant token rather than
 * nulled, because `orders.contact_phone` is NOT NULL by design and because two
 * orders from the same erased person must still be recognisable as one customer
 * for the seller's own totals. It is not reversible: the salt is the platform's.
 *
 * Deleting the rows outright is the easy version, and it would leave the seller
 * unable to answer BIR, unable to reconcile a courier statement, and with a
 * revenue figure that changed retroactively.
 */
create or replace function public.dsr_serve_deletion(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.data_subject_requests;
  v_digits text;
  v_ids uuid[];
  v_token text;
  v_orders int;
  v_messages int;
begin
  select * into v_req from public.data_subject_requests where id = p_request_id;
  if v_req.id is null then
    raise exception 'No such request' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_req.tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_req.kind <> 'deletion' then
    raise exception 'That request is not a deletion'
      using errcode = 'check_violation', hint = 'wrong_request_kind';
  end if;
  if v_req.status <> 'open' then
    raise exception 'That request has already been dealt with'
      using errcode = 'check_violation', hint = 'request_closed';
  end if;

  v_digits := public.ph_national_digits(v_req.subject_phone);
  -- A stable stand-in, unique per person per store. Same shape as a real number
  -- so every CHECK and every index keeps working; deterministic so the seller's
  -- own totals do not fragment.
  v_token := '+639' || lpad((
    ('x' || substr(md5(v_req.tenant_id::text || ':' || v_digits), 1, 8))::bit(32)::bigint
    % 1000000000)::text, 9, '0');

  select array_agg(id) into v_ids
  from public.customers
  where tenant_id = v_req.tenant_id and public.ph_national_digits(phone) = v_digits;

  -- The orders: the person goes, the transaction stays.
  with erased as (
    update public.orders
       set contact_name = 'Erased',
           contact_phone = v_token,
           contact_email = null,
           notes = null,
           shipping_address = jsonb_strip_nulls(jsonb_build_object(
             'regionCode',   shipping_address ->> 'regionCode',
             'provinceCode', shipping_address ->> 'provinceCode',
             'cityCode',     shipping_address ->> 'cityCode',
             'erased', true))
     where tenant_id = v_req.tenant_id
       and public.ph_national_digits(contact_phone) = v_digits
    returning 1)
  select count(*) into v_orders from erased;

  -- The conversations. There is no version of a Messenger thread that is only
  -- half about a person.
  with wiped as (
    update public.messages m
       set body = null, attachments = null
      from public.message_threads t
     where m.thread_id = t.id
       and t.tenant_id = v_req.tenant_id
       and t.customer_id = any(coalesce(v_ids, '{}'::uuid[]))
    returning 1)
  select count(*) into v_messages from wiped;

  delete from public.customer_addresses
  where tenant_id = v_req.tenant_id and customer_id = any(coalesce(v_ids, '{}'::uuid[]));

  update public.customers
     set name = 'Erased customer',
         phone = v_token,
         email = null,
         fb_psid = null,
         notes = null
   where tenant_id = v_req.tenant_id and id = any(coalesce(v_ids, '{}'::uuid[]));

  -- And they are opted out, permanently and by construction: the stand-in number
  -- is what a future import would have to match, and it never will.
  insert into public.privacy_consents
    (tenant_id, customer_id, purpose, granted, policy_version, source, evidence)
  select v_req.tenant_id, id, 'marketing', false,
         public.privacy_policy_version(), 'seller',
         jsonb_build_object('reason', 'deletion request', 'requestId', v_req.id)
  from unnest(coalesce(v_ids, '{}'::uuid[])) as id;

  update public.data_subject_requests
     set status = 'served', served_at = now(), served_by = auth.uid(),
         outcome = jsonb_build_object(
           'customers', coalesce(array_length(v_ids, 1), 0),
           'orders', v_orders, 'messages', v_messages,
           'method', 'erasure', 'recordsKept', true)
   where id = p_request_id;

  return jsonb_build_object('customers', coalesce(array_length(v_ids, 1), 0),
                            'orders', v_orders, 'messages', v_messages);
end;
$$;

/** Open a request. Staff, because the seller is the one who received it. */
create or replace function public.dsr_open(
  p_tenant_id uuid,
  p_kind text,
  p_phone text,
  p_email text default null,
  p_note text default null
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

  insert into public.data_subject_requests (tenant_id, kind, subject_phone, subject_email, note)
  values (p_tenant_id, p_kind, p_phone, lower(nullif(btrim(coalesce(p_email, '')), '')), p_note)
  returning id into v_id;
  return v_id;
end;
$$;

/** Close one without acting on it, with the reason on the row. */
create or replace function public.dsr_close(
  p_request_id uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.data_subject_requests where id = p_request_id;
  if v_tenant is null then
    raise exception 'No such request' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_tenant, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('refused', 'withdrawn') then
    raise exception 'A request is closed as refused or withdrawn'
      using errcode = 'check_violation';
  end if;

  update public.data_subject_requests
     set status = p_status, refused_reason = p_reason,
         served_at = now(), served_by = auth.uid()
   where id = p_request_id and status = 'open';
end;
$$;

/** The queue, with the ones that are late first. */
create or replace function public.dsr_list(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'phone', r.subject_phone, 'email', r.subject_email,
      'note', r.note, 'status', r.status, 'requestedAt', r.requested_at,
      'dueAt', r.due_at, 'servedAt', r.served_at, 'outcome', r.outcome,
      'refusedReason', r.refused_reason,
      'overdue', r.status = 'open' and r.due_at < now())
      order by (r.status = 'open') desc, r.due_at)
    from public.data_subject_requests r
    where r.tenant_id = p_tenant_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Breach log
-- ---------------------------------------------------------------------------
/**
 * What happened, when we found out, and when we have to have said so.
 *
 * The DPA gives 72 hours from *knowledge* of a notifiable breach to tell the NPC
 * and the affected people. So `notify_due_at` is derived from `discovered_at`,
 * not from `created_at` — a breach discovered on Friday and written up on Monday
 * has already spent most of its window, and a log that quietly restarts the clock
 * at the moment of typing is a log that will be wrong exactly when it matters.
 *
 * `tenant_id` is nullable: a breach can be one store's, or the platform's.
 */
create table public.breach_log (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete set null,

  discovered_at timestamptz not null,
  occurred_at   timestamptz,
  /**
   * 72 hours from knowledge, per the DPA. Derived, never typed — see the trigger
   * below. A generated column would say it better and Postgres will not have it:
   * `timestamptz + interval` is only STABLE, because adding an interval depends
   * on the session TimeZone, and a generated expression has to be IMMUTABLE.
   */
  notify_due_at timestamptz not null,

  nature text not null,
  description text not null,
  affected_count int,
  data_categories text[] not null default '{}',

  severity text not null default 'unknown'
    check (severity in ('unknown', 'low', 'medium', 'high')),
  notifiable boolean,
  status text not null default 'open'
    check (status in ('open', 'contained', 'notified', 'closed')),

  npc_notified_at   timestamptz,
  subjects_notified_at timestamptz,
  remediation text,

  recorded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id)
);

create index breach_log_open_idx on public.breach_log (notify_due_at)
  where status in ('open', 'contained');

/**
 * The 72-hour clock runs from *knowledge*, not from typing.
 *
 * A breach discovered on Friday and written up on Monday has already spent most
 * of its window. Deriving the deadline here rather than defaulting it at insert
 * is what stops the clock quietly restarting when somebody edits the row.
 */
create or replace function public.breach_notify_deadline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.notify_due_at := new.discovered_at + interval '72 hours';
  return new;
end;
$$;

create trigger breach_log_notify_deadline
  before insert or update of discovered_at on public.breach_log
  for each row execute function public.breach_notify_deadline();

create trigger breach_log_set_updated_at
  before update on public.breach_log
  for each row execute function public.set_updated_at();

/** Record one. Platform staff, or an admin of the store it concerns. */
create or replace function public.breach_record(
  p_nature text,
  p_description text,
  p_discovered_at timestamptz default now(),
  p_tenant_id uuid default null,
  p_affected_count int default null,
  p_severity text default 'unknown',
  p_data_categories text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if p_tenant_id is null then
    if not public.is_platform_admin() then
      raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
  elsif not public.is_platform_admin()
        and not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.breach_log
    (tenant_id, discovered_at, nature, description, affected_count, severity,
     data_categories, recorded_by)
  values (p_tenant_id, p_discovered_at, btrim(p_nature), btrim(p_description),
          p_affected_count, p_severity, coalesce(p_data_categories, '{}'), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Update an entry as the incident is worked.
 *
 * There is no UPDATE grant and no UPDATE policy on `breach_log`, so this is the
 * only way it moves — which is the point: a breach record that can be edited by
 * a `curl` is a breach record. What can change is the *handling* (contained,
 * notified, remediated) and the facts as they are established; what cannot is the
 * row's existence.
 *
 * `discovered_at` is editable because the first write is often a guess and the
 * real answer comes out of the investigation — and the trigger moves the 72-hour
 * deadline with it, in whichever direction the truth turns out to be.
 */
create or replace function public.breach_update(
  p_id uuid,
  p_status text default null,
  p_severity text default null,
  p_affected_count int default null,
  p_discovered_at timestamptz default null,
  p_npc_notified_at timestamptz default null,
  p_subjects_notified_at timestamptz default null,
  p_remediation text default null,
  p_notifiable boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_tenant uuid; v_exists boolean;
begin
  select tenant_id, true into v_tenant, v_exists from public.breach_log where id = p_id;
  if not coalesce(v_exists, false) then
    raise exception 'No such breach record' using errcode = 'no_data_found';
  end if;
  if v_tenant is null then
    if not public.is_platform_admin() then
      raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
  elsif not public.is_platform_admin() and not public.has_tenant_role(v_tenant, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  update public.breach_log
     set status = coalesce(p_status, status),
         severity = coalesce(p_severity, severity),
         affected_count = coalesce(p_affected_count, affected_count),
         discovered_at = coalesce(p_discovered_at, discovered_at),
         npc_notified_at = coalesce(p_npc_notified_at, npc_notified_at),
         subjects_notified_at = coalesce(p_subjects_notified_at, subjects_notified_at),
         remediation = coalesce(p_remediation, remediation),
         notifiable = coalesce(p_notifiable, notifiable)
   where id = p_id;
end;
$$;

/** The log, with the clock on each entry. */
create or replace function public.breach_list(p_tenant_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tenant_id is null then
    if not public.is_platform_admin() then
      raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
  elsif not public.is_platform_admin()
        and not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'tenantId', b.tenant_id, 'nature', b.nature,
      'description', b.description, 'discoveredAt', b.discovered_at,
      'notifyDueAt', b.notify_due_at, 'severity', b.severity, 'status', b.status,
      'affectedCount', b.affected_count, 'dataCategories', b.data_categories,
      'npcNotifiedAt', b.npc_notified_at, 'subjectsNotifiedAt', b.subjects_notified_at,
      'overdue', b.status in ('open', 'contained') and b.notify_due_at < now())
      order by b.discovered_at desc)
    from public.breach_log b
    where p_tenant_id is null or b.tenant_id = p_tenant_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.privacy_consents        enable row level security;
alter table public.privacy_consents        force  row level security;
alter table public.data_subject_requests   enable row level security;
alter table public.data_subject_requests   force  row level security;
alter table public.breach_log              enable row level security;
alter table public.breach_log              force  row level security;

create policy "Members read consents" on public.privacy_consents for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Members read requests" on public.data_subject_requests
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

/**
 * A store's own breaches, and the platform's.
 *
 * A seller can read a platform-wide entry (`tenant_id is null`) on purpose: if
 * Selld is breached, the sellers whose customers are in it are the people with
 * the most right to know, and a log they cannot see is a log that exists for us.
 */
create policy "Members read breaches" on public.breach_log for select to authenticated
  using (tenant_id is null
         or public.is_tenant_member(tenant_id)
         or public.is_platform_admin());

-- `rate_limit_counters` gets no policy at all. See the table comment.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select on public.privacy_consents      to authenticated;
grant select on public.data_subject_requests to authenticated;
grant select on public.breach_log            to authenticated;
-- Nothing on rate_limit_counters, to anybody.

-- `revoke all ... from public` first, always: Postgres grants EXECUTE to PUBLIC
-- on creation, and revoking from a named role does not take back a privilege
-- held *through* PUBLIC. And because that revoke also strips `service_role`,
-- every server-called function is granted back by name.
revoke all on function public.rate_limit_hit(text, int, int) from public;
revoke all on function public.rate_limit_sweep(interval) from public;
revoke all on function public.record_checkout_consent(text, uuid, boolean, text, jsonb) from public;
revoke all on function public.customer_may_market(uuid, uuid) from public;
revoke all on function public.enforce_marketing_consent() from public;
revoke all on function public.set_marketing_consent(uuid, uuid, boolean, text) from public;
revoke all on function public.dsr_open(uuid, text, text, text, text) from public;
revoke all on function public.dsr_close(uuid, text, text) from public;
revoke all on function public.dsr_list(uuid) from public;
revoke all on function public.dsr_export(uuid, text) from public;
revoke all on function public.dsr_serve_deletion(uuid) from public;
revoke all on function public.breach_notify_deadline() from public;
revoke all on function public.breach_record(text, text, timestamptz, uuid, int, text, text[]) from public;
revoke all on function public.breach_update(uuid, text, text, int, timestamptz, timestamptz, timestamptz, text, boolean) from public;
revoke all on function public.breach_list(uuid) from public;

-- The server's half: the rate limiter and the consent the checkout handler
-- records. `record_checkout_consent` is service-role only even though it is about
-- a buyer, because it takes a cart token and an order id — a client that could
-- call it could record a grant against somebody else's order.
grant execute on function public.rate_limit_hit(text, int, int) to service_role;
grant execute on function public.rate_limit_sweep(interval) to service_role;
grant execute on function public.record_checkout_consent(text, uuid, boolean, text, jsonb)
  to service_role;

-- The seller's half.
grant execute on function public.set_marketing_consent(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.customer_may_market(uuid, uuid) to authenticated;
grant execute on function public.dsr_open(uuid, text, text, text, text) to authenticated;
grant execute on function public.dsr_close(uuid, text, text) to authenticated;
grant execute on function public.dsr_list(uuid) to authenticated;
grant execute on function public.dsr_export(uuid, text) to authenticated;
grant execute on function public.dsr_serve_deletion(uuid) to authenticated;
grant execute on function public.breach_record(text, text, timestamptz, uuid, int, text, text[])
  to authenticated;
grant execute on function public.breach_update(uuid, text, text, int, timestamptz, timestamptz, timestamptz, text, boolean) to authenticated;
grant execute on function public.breach_list(uuid) to authenticated;

-- The policy version is read by the storefront to stamp a consent, so a buyer's
-- browser has to be able to ask for it.
grant execute on function public.privacy_policy_version() to anon, authenticated, service_role;

comment on table public.rate_limit_counters is
  'Fixed-window rate limit counters. RLS on, no policy, no grants: a counter a client can read tells it how close it is to the limit, and one it can write is not a limit.';
comment on table public.privacy_consents is
  'Append-only consent log. A withdrawal is a new row, never an update: "consented on the 3rd, withdrew on the 9th" is the fact a regulator asks about.';
comment on function public.dsr_serve_deletion(uuid) is
  'Serves a deletion request by erasure, not DELETE. The person is removed and the transaction is kept, because a seller is required to hold sales records.';
