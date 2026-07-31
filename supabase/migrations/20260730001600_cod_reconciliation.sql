-- ===========================================================================
-- Phase 12 — COD reconciliation and RTS control
-- ===========================================================================
--
-- Cash on delivery is how most Filipino social commerce is paid for, and it is
-- also where the money goes missing. The courier collects on the seller's behalf
-- and remits days or weeks later, minus fees, in a spreadsheet with its own
-- column names. Between those two events the seller is a creditor with no ledger.
--
-- Two questions have to be answerable in one screen, which is this phase's
-- done-when:
--
--   1. How much COD is the courier still holding?
--   2. Which parcels are unaccounted for?
--
-- Everything below exists to answer those, plus the second half of the story:
-- what happens when a parcel comes back instead.
--
-- ## The shape of the thing
--
-- `cod_remittances`      one imported statement (a batch)
-- `cod_remittance_lines` one row from that statement, matched or not
-- `order_rts`            a returned parcel, its cost, and where the stock went
-- `buyer_risk_flags`     an RTS rate per phone number, per tenant
-- `buyer_risk_signals`   the same signal, hashed and pooled across tenants
--
-- The matching is deliberately done in SQL rather than in the importer. The file
-- is parsed in the browser — it is the seller's own file and parsing it there
-- costs no round trip — but *what a line means* is decided against the seller's
-- own shipments, inside a function the seller cannot influence beyond the numbers
-- they typed. A client that could declare a line "matched" could declare a parcel
-- paid.

-- ---------------------------------------------------------------------------
-- Remittance batches
-- ---------------------------------------------------------------------------
/**
 * One courier statement, as imported.
 *
 * `declared_total_centavos` is what the *statement* claims it is paying out. It is
 * stored separately from the sum of the lines on purpose: when those two disagree
 * the statement itself is internally inconsistent, and a seller needs to know that
 * before they go arguing about individual parcels.
 *
 * A batch is `draft` until it is posted. Importing shows the seller what would
 * happen — how many lines matched, which did not, what the variance is — before
 * anything marks an order paid. An import that silently posted payments would make
 * a mis-selected courier format into a set of false "paid" flags across the book.
 */
create table public.cod_remittances (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  courier   text not null check (courier in ('jnt', 'flash', 'lbc', 'ninja', 'other')),
  /** The statement/payout reference printed on the file. Free text; couriers vary. */
  reference text,
  filename  text,

  /** What the statement says it covers, if it says. */
  period_start date,
  period_end   date,

  /** The payout total the statement declares, before Selld looks at the lines. */
  declared_total_centavos public.centavos,

  status text not null default 'draft' check (status in ('draft', 'posted', 'discarded')),

  imported_by uuid references public.profiles (id) on delete set null,
  posted_at   timestamptz,
  posted_by   uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id)
);

create index cod_remittances_tenant_idx
  on public.cod_remittances (tenant_id, created_at desc);

-- A courier does not send the same payout reference twice. Where one is present,
-- re-importing the same file is refused rather than silently doubling a seller's
-- recorded income.
create unique index cod_remittances_reference_idx
  on public.cod_remittances (tenant_id, courier, reference)
  where reference is not null and status <> 'discarded';

create trigger cod_remittances_touch
  before update on public.cod_remittances
  for each row execute function public.set_updated_at();

/**
 * One line of a statement.
 *
 * `match_status` is the whole point of the table. A courier's file is not a list of
 * payments to apply — it is a list of claims to check, and each claim can be wrong
 * in a different way:
 *
 *   matched        the waybill is ours, the amount agrees
 *   variance       the waybill is ours, the amount does not agree
 *   unknown_waybill  no shipment of ours carries that waybill
 *   duplicate      this waybill already appeared, in this batch or an earlier one
 *   not_cod        the order was paid online; the courier should not be remitting
 *
 * Only `matched` and `variance` post. The rest are the "unaccounted for" half of
 * the done-when, and they are what the seller actually has to act on.
 */
create table public.cod_remittance_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  remittance_id uuid not null,

  /** Where this row sat in the file, so a seller can find it again. */
  row_number int not null,

  waybill          text not null,
  amount_centavos  public.centavos not null,
  /** What the courier deducted, when the statement itemises it. */
  fee_centavos     public.centavos not null default 0,
  remitted_at      date,

  shipment_id uuid,
  order_id    uuid,

  match_status text not null check (
    match_status in ('matched', 'variance', 'unknown_waybill', 'duplicate', 'not_cod')
  ),
  /** Statement amount minus what the order says is due. Signed. */
  variance_centavos bigint not null default 0,

  /** The original row, for the seller who needs to see what the file actually said. */
  raw jsonb,

  created_at timestamptz not null default now(),

  -- Cross-tenant children are unrepresentable, not merely forbidden.
  foreign key (tenant_id, remittance_id)
    references public.cod_remittances (tenant_id, id) on delete cascade,
  foreign key (tenant_id, shipment_id)
    references public.shipments (tenant_id, id) on delete set null,
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete set null
);

create index cod_remittance_lines_batch_idx
  on public.cod_remittance_lines (tenant_id, remittance_id, row_number);
create index cod_remittance_lines_order_idx
  on public.cod_remittance_lines (tenant_id, order_id) where order_id is not null;

-- One posted line per shipment, ever. This is what makes re-importing an
-- overlapping statement safe: the second copy lands as `duplicate` rather than as
-- a second payment. A partial index rather than a plain unique, because the
-- unmatched rows have no shipment at all and several may share a null.
create unique index cod_remittance_lines_shipment_paid_idx
  on public.cod_remittance_lines (tenant_id, shipment_id)
  where shipment_id is not null and match_status in ('matched', 'variance');

-- ---------------------------------------------------------------------------
-- Returned parcels
-- ---------------------------------------------------------------------------
/**
 * An RTS, with its cost and what happened to the goods.
 *
 * A returned parcel is not just a status. The seller paid to ship it out, usually
 * pays again to have it come back, and either gets the stock back or does not. All
 * three are money, and a seller who cannot see the total has no way to know that
 * their COD business is unprofitable in a particular area — which is exactly the
 * decision this table exists to inform.
 *
 * Kept separate from `orders` rather than as three more columns because an order
 * can legitimately be re-dispatched and come back twice, and because the row is
 * where the stock movement's reference points.
 */
create table public.order_rts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id  uuid not null,
  shipment_id uuid,

  reason text not null check (
    reason in ('buyer_unreachable', 'buyer_refused', 'wrong_address',
               'buyer_cancelled', 'damaged', 'other')
  ),
  note text,

  /** What the seller has already paid to ship it out. */
  outbound_cost_centavos public.centavos not null default 0,
  /** What the courier charges to bring it back. Often the same again. */
  return_cost_centavos   public.centavos not null default 0,

  /** Whether the goods came back saleable, and where they went. */
  restocked   boolean not null default false,
  location_id uuid,

  recorded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, shipment_id)
    references public.shipments (tenant_id, id) on delete set null,
  foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete set null
);

create index order_rts_tenant_idx on public.order_rts (tenant_id, created_at desc);
create index order_rts_order_idx  on public.order_rts (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- Buyer risk
-- ---------------------------------------------------------------------------
/**
 * An RTS rate per phone number.
 *
 * Keyed on `ph_national_digits(phone)` rather than on the raw string, for the same
 * reason order search is: the same buyer appears as `09171234567` and
 * `+639171234567` and neither contains the other. Phase 11's helper already
 * reduces both to `9171234567`.
 *
 * Deliberately *not* keyed on `customers`. A returning buyer who checks out as a
 * guest under a slightly different name is a different customer row and the same
 * phone, and it is the phone the rider calls.
 *
 * `block_cod` is a seller's explicit decision, never inferred. A computed score can
 * be wrong — a buyer who moved house has a bad month — and refusing someone's money
 * automatically, on a signal they cannot see or appeal, is not a thing to do
 * silently. The score is shown; the block is chosen.
 */
create table public.buyer_risk_flags (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  /** National digits, e.g. `9171234567`. */
  phone_digits text not null check (phone_digits ~ '^[0-9]{7,12}$'),

  orders_count    int not null default 0 check (orders_count >= 0),
  delivered_count int not null default 0 check (delivered_count >= 0),
  rts_count       int not null default 0 check (rts_count >= 0),

  /** RTS as a share of parcels that reached a conclusion, in basis points. */
  rts_rate_bps int not null default 0 check (rts_rate_bps between 0 and 10000),

  /** Seller decisions, never inferred. */
  block_cod boolean not null default false,
  trusted   boolean not null default false,
  note      text,

  last_rts_at timestamptz,
  updated_at  timestamptz not null default now(),

  unique (tenant_id, phone_digits)
);

create index buyer_risk_flags_tenant_idx
  on public.buyer_risk_flags (tenant_id, rts_rate_bps desc);

/**
 * The same signal, pooled across tenants — and the reason it is a separate table.
 *
 * This is the network effect the product is built around: a buyer who burns one
 * seller usually burns several, and no single seller has enough history to see it.
 * A shared signal is worth more than anything Selld can compute alone.
 *
 * It is also the most dangerous table in the schema, so:
 *
 * - **The phone is stored hashed**, never in the clear. A dump of this table is a
 *   list of hashes with counts attached, not a directory of Filipino phone numbers
 *   annotated with "unreliable".
 * - **No tenant column, and no way back to one.** The row says how many stores have
 *   seen this number and how it went; it never says which stores, so it cannot be
 *   used to work out who a seller's customers are.
 * - **Contribution is opt-in** (`risk.contribute_signal`), and consumption is opt-in
 *   separately (`risk.use_shared_signal`). A seller who will not share does not get
 *   to read, but a seller who shares is not forced to act on what comes back.
 * - **Nothing here blocks anything by itself.** It is a number on a screen next to
 *   the seller's own number.
 *
 * The hash is salted with a value held outside Postgres, exactly like the courier
 * credential key: a stolen dump plus a phone book would otherwise let anyone
 * confirm whether a given number is in here.
 */
create table public.buyer_risk_signals (
  phone_hash text primary key,

  tenants_seen   int not null default 0 check (tenants_seen >= 0),
  orders_count   int not null default 0 check (orders_count >= 0),
  delivered_count int not null default 0 check (delivered_count >= 0),
  rts_count      int not null default 0 check (rts_count >= 0),

  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

/**
 * Which tenants have contributed which hashes.
 *
 * Needed so a second order from the same buyer at the same store does not count as
 * a second store — `tenants_seen` is the whole value of the signal and an inflated
 * one is worse than none. The tenant id is here, but this table is readable by
 * nobody: it is a bookkeeping index for the aggregate above, and it is the one
 * place the join back to a store exists.
 */
create table public.buyer_risk_contributions (
  phone_hash text not null,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  orders_count    int not null default 0,
  delivered_count int not null default 0,
  rts_count       int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (phone_hash, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Importing a statement
-- ---------------------------------------------------------------------------
/**
 * Take a parsed statement and decide what every line means.
 *
 * The file is parsed in the browser (`src/core/cod`), because it is the seller's
 * own file, parsing it there costs no upload, and a 3,000-row spreadsheet does not
 * need to cross the network twice. What arrives here is a normalised array:
 * `[{ waybill, amount, fee, remittedAt, raw }]`.
 *
 * **Nothing the client sends decides anything.** The client says "the courier
 * claims waybill X paid 1,45000". This function decides whether X is ours, whether
 * that agrees with the order, and whether it was already paid. A client that could
 * assert `match_status` could assert that an unpaid order is paid.
 *
 * Creates the batch as `draft`. Posting is a separate, explicit act — see
 * `cod_post_remittance`.
 */
create or replace function public.cod_import_statement(
  p_tenant_id uuid,
  p_courier   text,
  p_lines     jsonb,
  p_reference text default null,
  p_filename  text default null,
  p_declared_total bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := p_tenant_id;
  v_batch  uuid;
  v_count  int;
begin
  if not public.has_tenant_role(v_tenant, 'staff') then
    raise exception 'Not allowed to import remittances for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'No statement lines' using errcode = 'check_violation', hint = 'empty_file';
  end if;

  v_count := jsonb_array_length(p_lines);
  if v_count = 0 then
    raise exception 'That file has no rows we recognise'
      using errcode = 'check_violation', hint = 'empty_file';
  end if;

  -- A ceiling well above any real payout run. A courier statement is a month of
  -- one seller's parcels, not a database.
  if v_count > 20000 then
    raise exception 'That statement has too many rows (max 20000)'
      using errcode = 'program_limit_exceeded';
  end if;

  insert into public.cod_remittances
    (tenant_id, courier, reference, filename, declared_total_centavos, imported_by)
  values (v_tenant, p_courier, nullif(btrim(coalesce(p_reference, '')), ''), p_filename,
          p_declared_total, auth.uid())
  returning id into v_batch;

  -- One statement, one pass. Everything below is set-based: a 3,000-line file is
  -- one insert, not 3,000 round trips.
  with parsed as (
    select
      (ordinality)::int                                as row_number,
      upper(btrim(line ->> 'waybill'))                 as waybill,
      coalesce((line ->> 'amount')::bigint, 0)         as amount,
      coalesce((line ->> 'fee')::bigint, 0)            as fee,
      nullif(line ->> 'remittedAt', '')::date          as remitted_at,
      line -> 'raw'                                    as raw
    from jsonb_array_elements(p_lines) with ordinality as t(line, ordinality)
  ),
  -- Match on the waybill as the courier printed it, case- and space-insensitively.
  -- Couriers pad, lowercase and occasionally quote their own waybills.
  resolved as (
    select
      p.*,
      s.id       as shipment_id,
      s.order_id as order_id,
      o.payment_method,
      o.payment_status,
      o.grand_total_centavos::bigint as due,
      -- Already remitted, in an earlier batch or earlier in this one.
      (s.id is not null and exists (
        select 1 from public.cod_remittance_lines l
        where l.tenant_id = v_tenant and l.shipment_id = s.id
          and l.match_status in ('matched', 'variance')
      )) as already,
      row_number() over (partition by s.id order by p.row_number) as nth
    from parsed p
      left join public.shipments s
        on s.tenant_id = v_tenant and upper(s.waybill) = p.waybill
      left join public.orders o
        on o.tenant_id = v_tenant and o.id = s.order_id
  )
  insert into public.cod_remittance_lines
    (tenant_id, remittance_id, row_number, waybill, amount_centavos, fee_centavos,
     remitted_at, shipment_id, order_id, match_status, variance_centavos, raw)
  select
    v_tenant, v_batch, r.row_number, r.waybill, r.amount, r.fee, r.remitted_at,
    -- A line that resolves to nothing must not carry a shipment id, and a
    -- duplicate must not either — the partial unique index is what enforces
    -- "one payment per parcel", and it can only do that if losers drop the id.
    case when r.shipment_id is not null and not r.already and r.nth = 1
         then r.shipment_id end,
    case when r.shipment_id is not null and not r.already and r.nth = 1
         then r.order_id end,
    case
      when r.shipment_id is null              then 'unknown_waybill'
      when r.already or r.nth > 1             then 'duplicate'
      when r.payment_method <> 'cod'          then 'not_cod'
      when r.amount + r.fee = r.due           then 'matched'
      else 'variance'
    end,
    case when r.shipment_id is null or r.already or r.nth > 1 then 0
         else r.amount + r.fee - r.due end,
    r.raw
  from resolved r;

  return public.cod_remittance_summary(v_batch);
end;
$$;

/**
 * What one batch adds up to.
 *
 * Split out from the import so the same numbers are available before and after
 * posting, and so the review screen and the import response cannot disagree about
 * what a batch contains.
 */
create or replace function public.cod_remittance_summary(p_remittance_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch record;
  v_lines jsonb;
begin
  select * into v_batch from public.cod_remittances where id = p_remittance_id;
  if v_batch.id is null then return null; end if;

  if not public.is_tenant_member(v_batch.tenant_id) then
    raise exception 'Not allowed to read this remittance'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_object_agg(match_status, jsonb_build_object(
           'count', n, 'amount', amount, 'variance', variance))
    into v_lines
  from (
    select match_status, count(*)::int as n,
           sum(amount_centavos::bigint) as amount,
           sum(variance_centavos)       as variance
    from public.cod_remittance_lines
    where remittance_id = p_remittance_id
    group by match_status
  ) g;

  return jsonb_build_object(
    'id',        v_batch.id,
    'courier',   v_batch.courier,
    'reference', v_batch.reference,
    'filename',  v_batch.filename,
    'status',    v_batch.status,
    'createdAt', v_batch.created_at,
    'postedAt',  v_batch.posted_at,
    'declaredTotal', v_batch.declared_total_centavos,
    'lineTotal', (select coalesce(sum(amount_centavos::bigint + fee_centavos::bigint), 0)
                  from public.cod_remittance_lines where remittance_id = p_remittance_id),
    'lineCount', (select count(*)::int
                  from public.cod_remittance_lines where remittance_id = p_remittance_id),
    'byStatus',  coalesce(v_lines, '{}'::jsonb)
  );
end;
$$;

/**
 * The lines of a batch, for the review screen.
 *
 * Ordered so the rows a seller has to act on come first. A statement is mostly
 * boring: three hundred matched lines and four problems, and the four are the
 * reason the screen exists.
 */
create or replace function public.cod_remittance_lines(
  p_remittance_id uuid,
  p_only_problems boolean default false,
  p_limit int default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.cod_remittances where id = p_remittance_id;
  if v_tenant is null then return '[]'::jsonb; end if;
  if not public.is_tenant_member(v_tenant) then
    raise exception 'Not allowed to read this remittance'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.sort, x.row_number)
    from (
      select
        l.id, l.row_number, l.waybill,
        l.amount_centavos as amount, l.fee_centavos as fee,
        l.remitted_at     as "remittedAt",
        l.match_status    as "matchStatus",
        l.variance_centavos as variance,
        o.order_number    as "orderNumber",
        o.contact_name    as "contactName",
        o.grand_total_centavos as due,
        case l.match_status
          when 'variance'        then 0
          when 'unknown_waybill' then 1
          when 'duplicate'       then 2
          when 'not_cod'         then 3
          else 9
        end as sort
      from public.cod_remittance_lines l
        left join public.orders o on o.id = l.order_id
      where l.remittance_id = p_remittance_id
        and (not p_only_problems or l.match_status <> 'matched')
      order by sort, l.row_number
      limit greatest(least(coalesce(p_limit, 500), 2000), 1)
    ) x
  ), '[]'::jsonb);
end;
$$;

/**
 * Post a batch: mark the matched parcels paid.
 *
 * Goes through `record_cod_remittance` per order rather than writing `payments`
 * rows directly, so a remitted COD order lands in exactly the same state as one a
 * seller ticked off by hand — one code path decides what "paid" means.
 *
 * `variance` lines post too, at the amount the courier actually paid. Refusing them
 * would leave a seller with a parcel that is neither paid nor outstanding, which is
 * the worst of the three states: the money arrived, it was just the wrong amount,
 * and that argument is with the courier and not with the ledger.
 */
create or replace function public.cod_post_remittance(p_remittance_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch  record;
  v_line   record;
  v_posted int := 0;
  v_amount bigint := 0;
begin
  select * into v_batch from public.cod_remittances where id = p_remittance_id;
  if v_batch.id is null then
    raise exception 'Remittance not found' using errcode = 'no_data_found';
  end if;

  if not public.has_tenant_role(v_batch.tenant_id, 'staff') then
    raise exception 'Not allowed to post remittances for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- Posting twice would pay every order twice. The status is the guard, and it is
  -- checked inside the same transaction that flips it.
  if v_batch.status = 'posted' then
    return jsonb_build_object('outcome', 'already_posted', 'posted', 0);
  end if;
  if v_batch.status = 'discarded' then
    raise exception 'That statement was discarded' using errcode = 'check_violation';
  end if;

  for v_line in
    select l.*, o.payment_status
    from public.cod_remittance_lines l
      join public.orders o on o.id = l.order_id
    where l.remittance_id = p_remittance_id
      and l.match_status in ('matched', 'variance')
    order by l.row_number
  loop
    -- An order somebody already ticked off by hand is not paid again.
    if v_line.payment_status = 'paid' then
      continue;
    end if;

    perform public.record_cod_remittance(
      v_line.order_id,
      v_line.amount_centavos::bigint + v_line.fee_centavos::bigint,
      format('%s remittance %s', upper(v_batch.courier),
             coalesce(v_batch.reference, to_char(v_batch.created_at, 'YYYY-MM-DD'))));

    v_posted := v_posted + 1;
    v_amount := v_amount + v_line.amount_centavos::bigint;
  end loop;

  update public.cod_remittances
     set status = 'posted', posted_at = now(), posted_by = auth.uid()
   where id = p_remittance_id;

  return jsonb_build_object(
    'outcome', 'posted', 'posted', v_posted, 'amount', v_amount,
    'summary', public.cod_remittance_summary(p_remittance_id));
end;
$$;

/** Throw away a draft that was imported against the wrong courier format. */
create or replace function public.cod_discard_remittance(p_remittance_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_batch record;
begin
  select * into v_batch from public.cod_remittances where id = p_remittance_id;
  if v_batch.id is null then
    raise exception 'Remittance not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_batch.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_batch.status = 'posted' then
    raise exception 'A posted statement cannot be discarded — reverse the payments instead'
      using errcode = 'check_violation', hint = 'already_posted';
  end if;

  -- The lines go too. Leaving them would keep every waybill in this batch marked
  -- as already-remitted, so re-importing the corrected file would land entirely as
  -- duplicates — a seller stuck in a loop with no way out but support.
  delete from public.cod_remittance_lines where remittance_id = p_remittance_id;
  update public.cod_remittances set status = 'discarded' where id = p_remittance_id;

  return jsonb_build_object('outcome', 'discarded');
end;
$$;

-- ---------------------------------------------------------------------------
-- The one screen
-- ---------------------------------------------------------------------------
/**
 * "How much COD is the courier still holding, and which parcels are unaccounted
 * for?" — in one round trip.
 *
 * One function rather than five, for the same reason `storefront_home()` is one:
 * this is a screen a seller opens while on the phone to a courier, and five
 * queries is five chances for one of them to be slow.
 *
 * The two halves of the answer:
 *
 * **Outstanding** — parcels that were delivered COD and have not been remitted.
 * That is the money the courier is holding. Bucketed by how long it has been sitting
 * there, because "₱48,000 outstanding" is a fact and "₱12,000 of it is over 30 days
 * old" is a phone call.
 *
 * **Unaccounted for** — everything that is neither delivered-and-remitted nor
 * honestly still moving. Parcels marked delivered with no scan for weeks, statement
 * lines whose waybill we do not recognise, and lines whose amount disagreed.
 *
 * Deliberately computed from `shipments` and `payments` rather than from a running
 * total anywhere. A reconciliation screen that reconciles against its own cached
 * figure is not reconciling.
 */
create or replace function public.cod_reconciliation(
  p_tenant_id uuid,
  p_days      int default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed to read this tenant''s COD position'
      using errcode = 'insufficient_privilege';
  end if;

  v_since := now() - make_interval(days => greatest(least(coalesce(p_days, 90), 365), 1));

  with cod as (
    -- Every COD parcel this tenant has in play. `delivered_at` is the courier's
    -- own timestamp from phase 11, which is what the ageing has to be measured
    -- from — not when Selld noticed.
    select
      s.id as shipment_id, s.waybill, s.courier, s.status as shipment_status,
      coalesce(s.delivered_at, s.booked_at) as at,
      o.id as order_id, o.order_number, o.contact_name, o.placed_at,
      o.grand_total_centavos::bigint as due,
      o.payment_status, o.fulfillment_status
    from public.shipments s
      join public.orders o on o.id = s.order_id
    where s.tenant_id = p_tenant_id
      and o.payment_method = 'cod'
      and o.placed_at >= v_since
      and s.status <> 'cancelled'
  ),
  -- Delivered, COD, and nobody has paid us for it yet.
  outstanding as (
    select *, (extract(epoch from (now() - at)) / 86400)::int as age_days
    from cod
    where shipment_status = 'delivered' and payment_status <> 'paid'
  ),
  -- Still on a van. Not late, not missing — just not money yet.
  in_transit as (
    select * from cod
    where shipment_status in ('booked','picked_up','in_transit','out_for_delivery')
  ),
  -- Came back. The COD will never arrive, and that is the point of `order_rts`.
  returned as (
    select * from cod where shipment_status in ('returning','returned')
  )
  select jsonb_build_object(
    'sinceDays', greatest(least(coalesce(p_days, 90), 365), 1),

    -- ---- How much is the courier holding -------------------------------
    'outstanding', jsonb_build_object(
      'count',  (select count(*)::int from outstanding),
      'amount', (select coalesce(sum(due), 0) from outstanding),
      -- Ageing. 30+ days is the line at which a PH courier's payout is late
      -- rather than pending; most remit weekly to fortnightly.
      'buckets', jsonb_build_object(
        'd0_7',   (select coalesce(sum(due), 0) from outstanding where age_days <= 7),
        'd8_14',  (select coalesce(sum(due), 0) from outstanding where age_days between 8 and 14),
        'd15_30', (select coalesce(sum(due), 0) from outstanding where age_days between 15 and 30),
        'd31',    (select coalesce(sum(due), 0) from outstanding where age_days > 30)),
      'overdueCount', (select count(*)::int from outstanding where age_days > 30),
      'byCourier', coalesce((
        select jsonb_agg(jsonb_build_object(
          'courier', courier, 'count', n, 'amount', amount, 'oldestDays', oldest)
          order by amount desc)
        from (select courier, count(*)::int as n, sum(due) as amount, max(age_days) as oldest
              from outstanding group by courier) c), '[]'::jsonb),
      -- The individual parcels, oldest first: this is the list a seller reads out.
      'parcels', coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderId', order_id, 'orderNumber', order_number, 'contactName', contact_name,
          'courier', courier, 'waybill', waybill, 'amount', due,
          'deliveredAt', at, 'ageDays', age_days) order by age_days desc)
        from (select * from outstanding order by age_days desc limit 200) p), '[]'::jsonb)),

    -- ---- Still moving ---------------------------------------------------
    'inTransit', jsonb_build_object(
      'count',  (select count(*)::int from in_transit),
      'amount', (select coalesce(sum(due), 0) from in_transit)),

    -- ---- Came back instead ----------------------------------------------
    'returned', jsonb_build_object(
      'count',  (select count(*)::int from returned),
      'amount', (select coalesce(sum(due), 0) from returned),
      'cost',   (select coalesce(sum(outbound_cost_centavos::bigint
                                    + return_cost_centavos::bigint), 0)
                 from public.order_rts where tenant_id = p_tenant_id
                   and created_at >= v_since)),

    -- ---- Already settled -------------------------------------------------
    'remitted', jsonb_build_object(
      'count',  (select count(*)::int from public.cod_remittance_lines l
                  join public.cod_remittances b on b.id = l.remittance_id
                 where l.tenant_id = p_tenant_id and b.status = 'posted'
                   and l.match_status in ('matched','variance')
                   and b.posted_at >= v_since),
      'amount', (select coalesce(sum(l.amount_centavos::bigint), 0)
                 from public.cod_remittance_lines l
                  join public.cod_remittances b on b.id = l.remittance_id
                 where l.tenant_id = p_tenant_id and b.status = 'posted'
                   and l.match_status in ('matched','variance')
                   and b.posted_at >= v_since),
      'variance', (select coalesce(sum(l.variance_centavos), 0)
                   from public.cod_remittance_lines l
                    join public.cod_remittances b on b.id = l.remittance_id
                   where l.tenant_id = p_tenant_id and b.status = 'posted'
                     and b.posted_at >= v_since)),

    -- ---- Which parcels are unaccounted for -------------------------------
    -- Three different kinds of "we cannot explain this", kept apart because the
    -- seller does something different about each.
    'unaccounted', jsonb_build_object(
      -- Delivered a month ago, still not paid. The courier is late or the money
      -- is gone.
      'overdue', coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderNumber', order_number, 'courier', courier, 'waybill', waybill,
          'amount', due, 'ageDays', age_days) order by age_days desc)
        from (select * from outstanding where age_days > 30 order by age_days desc limit 100) o
      ), '[]'::jsonb),
      -- The courier paid us for a waybill we have no record of. Usually a
      -- mis-keyed number; occasionally another merchant's parcel.
      'unknownWaybills', coalesce((
        select jsonb_agg(jsonb_build_object(
          'waybill', l.waybill, 'amount', l.amount_centavos,
          'courier', b.courier, 'batchId', b.id) order by l.created_at desc)
        from public.cod_remittance_lines l
          join public.cod_remittances b on b.id = l.remittance_id
        where l.tenant_id = p_tenant_id and l.match_status = 'unknown_waybill'
          and b.status <> 'discarded'
        limit 100), '[]'::jsonb),
      -- Paid, but not what the order said. Each of these is an argument worth
      -- having, and in aggregate it is how a seller notices a courier that
      -- systematically under-remits.
      'variances', coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderNumber', o.order_number, 'waybill', l.waybill,
          'expected', o.grand_total_centavos, 'received', l.amount_centavos,
          'variance', l.variance_centavos, 'courier', b.courier)
          order by abs(l.variance_centavos) desc)
        from public.cod_remittance_lines l
          join public.cod_remittances b on b.id = l.remittance_id
          left join public.orders o on o.id = l.order_id
        where l.tenant_id = p_tenant_id and l.match_status = 'variance'
          and b.status <> 'discarded'
        limit 100), '[]'::jsonb)),

    -- ---- Statements, most recent first -----------------------------------
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'courier', b.courier, 'reference', b.reference,
        'filename', b.filename, 'status', b.status,
        'createdAt', b.created_at, 'postedAt', b.posted_at,
        'lineCount', (select count(*)::int from public.cod_remittance_lines l
                       where l.remittance_id = b.id),
        'problemCount', (select count(*)::int from public.cod_remittance_lines l
                          where l.remittance_id = b.id and l.match_status <> 'matched'),
        'amount', (select coalesce(sum(l.amount_centavos::bigint), 0)
                   from public.cod_remittance_lines l where l.remittance_id = b.id))
        order by b.created_at desc)
      from (select * from public.cod_remittances
            where tenant_id = p_tenant_id and status <> 'discarded'
            order by created_at desc limit 20) b), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Buyer risk
-- ---------------------------------------------------------------------------
/**
 * Recompute one buyer's risk row from their order history.
 *
 * Derived, never incremented. An incrementing counter drifts the first time an
 * order is cancelled, re-dispatched, or deleted, and a risk score that quietly
 * drifts is worse than none — it will eventually refuse a good customer's money
 * for a reason nobody can reconstruct.
 *
 * `rts_rate_bps` is measured against parcels that *reached a conclusion*, not
 * against all orders. A buyer with one delivered order and three in transit is not
 * 75% reliable; they are 100% so far, on one data point, and the count is right
 * there next to the rate so a seller can see how thin it is.
 */
create or replace function public.buyer_risk_refresh(
  p_tenant_id uuid,
  p_phone     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digits    text := public.ph_national_digits(p_phone);
  v_orders    int;
  v_delivered int;
  v_rts       int;
  v_last      timestamptz;
  v_rate      int;
begin
  if v_digits is null or length(v_digits) < 7 then
    return null;
  end if;

  select
    count(*)::int,
    count(*) filter (where fulfillment_status = 'delivered')::int,
    count(*) filter (where fulfillment_status = 'rts')::int,
    max(updated_at) filter (where fulfillment_status = 'rts')
  into v_orders, v_delivered, v_rts, v_last
  from public.orders
  where tenant_id = p_tenant_id
    and public.ph_national_digits(contact_phone) = v_digits
    and fulfillment_status <> 'cancelled';

  v_rate := case when v_delivered + v_rts = 0 then 0
                 else round((v_rts::numeric * 10000) / (v_delivered + v_rts))::int end;

  insert into public.buyer_risk_flags
    (tenant_id, phone_digits, orders_count, delivered_count, rts_count,
     rts_rate_bps, last_rts_at, updated_at)
  values (p_tenant_id, v_digits, v_orders, v_delivered, v_rts, v_rate, v_last, now())
  on conflict (tenant_id, phone_digits) do update
    set orders_count    = excluded.orders_count,
        delivered_count = excluded.delivered_count,
        rts_count       = excluded.rts_count,
        rts_rate_bps    = excluded.rts_rate_bps,
        last_rts_at     = excluded.last_rts_at,
        updated_at      = now();

  -- Feed the pool, if this store has opted in.
  perform public.buyer_risk_contribute(p_tenant_id, v_digits, v_orders, v_delivered, v_rts);

  return jsonb_build_object(
    'phoneDigits', v_digits, 'orders', v_orders, 'delivered', v_delivered,
    'rts', v_rts, 'rtsRateBps', v_rate);
end;
$$;

/**
 * The hash under which a phone number enters the shared pool.
 *
 * HMAC with a salt held in the *server's* environment, exactly like the courier
 * credential key and for the same threat model: a stolen database dump plus the
 * Philippine numbering plan is a 900-million-entry rainbow table that anyone can
 * generate in an afternoon. Without the salt in the dump, the hashes are inert.
 *
 * Returns null when no salt is configured, and every caller treats that as "the
 * pool is off". Hashing with a default salt would be worse than not hashing at
 * all: it would look safe.
 */
create or replace function public.buyer_risk_hash(p_digits text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_salt text;
begin
  select value #>> '{}' into v_salt
  from public.platform_secrets where key = 'buyer_risk_salt';

  if v_salt is null or length(v_salt) < 16 then
    return null;
  end if;
  return encode(extensions.hmac(p_digits, v_salt, 'sha256'), 'hex');
end;
$$;

/**
 * Platform-level secrets, readable by nobody.
 *
 * One row, one key, no tenant column and no grants at all — the only readers are
 * `SECURITY DEFINER` functions in this file. It exists because the risk-pool salt
 * has to be stable across every tenant and every request, which rules out passing
 * it in per call the way `COURIER_CREDENTIALS_KEY` is.
 *
 * That is a real trade-off against phase 10's reasoning, and it is made knowingly:
 * a salt in the database is weaker than a key outside it, but a *per-request* salt
 * would let one caller silently fork the pool into two incompatible hash spaces,
 * which destroys the signal for everyone. The mitigation is that the salt protects
 * pseudonymity, not money.
 */
create table public.platform_secrets (
  key   text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.platform_secrets enable row level security;
alter table public.platform_secrets force  row level security;
-- No policies and no grants. Deliberate: `SECURITY DEFINER` owners bypass both.

/**
 * Add one buyer's history to the shared pool, if this store contributes.
 *
 * The per-tenant contribution row is what keeps `tenants_seen` honest. Without it,
 * a store with fifty orders from one buyer would look like fifty stores, and the
 * one number that makes a shared signal worth reading would be a lie.
 */
create or replace function public.buyer_risk_contribute(
  p_tenant_id uuid,
  p_digits    text,
  p_orders    int,
  p_delivered int,
  p_rts       int
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  if not coalesce((
    select (value #>> '{}')::boolean from public.tenant_settings
    where tenant_id = p_tenant_id and key = 'risk.contribute_signal'
  ), false) then
    return;
  end if;

  v_hash := public.buyer_risk_hash(p_digits);
  if v_hash is null then return; end if;

  insert into public.buyer_risk_contributions
    (phone_hash, tenant_id, orders_count, delivered_count, rts_count, updated_at)
  values (v_hash, p_tenant_id, p_orders, p_delivered, p_rts, now())
  on conflict (phone_hash, tenant_id) do update
    set orders_count = excluded.orders_count,
        delivered_count = excluded.delivered_count,
        rts_count = excluded.rts_count,
        updated_at = now();

  -- Recomputed from the contributions rather than incremented, so a store that
  -- corrects its own history corrects the pool too.
  insert into public.buyer_risk_signals
    (phone_hash, tenants_seen, orders_count, delivered_count, rts_count, updated_at)
  select v_hash, count(*)::int, sum(orders_count)::int,
         sum(delivered_count)::int, sum(rts_count)::int, now()
  from public.buyer_risk_contributions where phone_hash = v_hash
  on conflict (phone_hash) do update
    set tenants_seen    = excluded.tenants_seen,
        orders_count    = excluded.orders_count,
        delivered_count = excluded.delivered_count,
        rts_count       = excluded.rts_count,
        updated_at      = now();
end;
$$;

/**
 * What this store knows, and what everyone else knows, about one phone number.
 *
 * The two are returned side by side and never merged into a single score. They mean
 * different things — "this buyer has burned *me* twice" is not the same claim as
 * "this buyer has burned two of the other four stores who have seen them" — and a
 * seller deciding whether to take a ₱3,000 COD order deserves both, not an average.
 *
 * The shared half is withheld unless this store both contributes and consumes.
 * Reading without contributing is a free ride on other sellers' data; the setting
 * pair is what makes the pool a mutual thing rather than an extraction.
 */
create or replace function public.buyer_risk_lookup(
  p_tenant_id uuid,
  p_phone     text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_digits text := public.ph_national_digits(p_phone);
  v_own    record;
  -- Built as jsonb rather than held in a `record`: a plpgsql record that is never
  -- assigned cannot even be tested for null ("the tuple structure of a
  -- not-yet-assigned record is indeterminate"), and the whole point here is that
  -- the shared half is usually absent.
  v_shared jsonb := null;
  v_row    record;
  v_hash   text;
  v_use    boolean;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_digits is null or length(v_digits) < 7 then return null; end if;

  select * into v_own from public.buyer_risk_flags
  where tenant_id = p_tenant_id and phone_digits = v_digits;

  v_use := coalesce((
    select (value #>> '{}')::boolean from public.tenant_settings
    where tenant_id = p_tenant_id and key = 'risk.use_shared_signal'), false)
    and coalesce((
    select (value #>> '{}')::boolean from public.tenant_settings
    where tenant_id = p_tenant_id and key = 'risk.contribute_signal'), false);

  if v_use then
    v_hash := public.buyer_risk_hash(v_digits);
    if v_hash is not null then
      select * into v_row from public.buyer_risk_signals where phone_hash = v_hash;
      if v_row.phone_hash is not null then
        -- Only the *other* stores' share. A seller who could read their own
        -- contribution back out of the pool would take it for corroboration —
        -- their own two bad experiences would read as four.
        v_shared := jsonb_build_object(
          'tenantsSeen', greatest(v_row.tenants_seen - 1, 0),
          'orders',    greatest(v_row.orders_count    - coalesce(v_own.orders_count, 0), 0),
          'delivered', greatest(v_row.delivered_count - coalesce(v_own.delivered_count, 0), 0),
          'rts',       greatest(v_row.rts_count       - coalesce(v_own.rts_count, 0), 0));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'phoneDigits', v_digits,
    'own', case when v_own.phone_digits is null then null else jsonb_build_object(
      'orders', v_own.orders_count, 'delivered', v_own.delivered_count,
      'rts', v_own.rts_count, 'rtsRateBps', v_own.rts_rate_bps,
      'blockCod', v_own.block_cod, 'trusted', v_own.trusted,
      'note', v_own.note, 'lastRtsAt', v_own.last_rts_at) end,
    'shared', v_shared);
end;
$$;

/** A seller's own decision about a buyer. Never inferred, always explicit. */
create or replace function public.buyer_risk_set_flag(
  p_tenant_id uuid,
  p_phone     text,
  p_block_cod boolean default null,
  p_trusted   boolean default null,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digits text := public.ph_national_digits(p_phone);
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to flag buyers for this tenant'
      using errcode = 'insufficient_privilege';
  end if;
  if v_digits is null or length(v_digits) < 7 then
    raise exception 'That is not a usable phone number'
      using errcode = 'check_violation', hint = 'contact_phone';
  end if;

  perform public.buyer_risk_refresh(p_tenant_id, p_phone);

  update public.buyer_risk_flags
     set block_cod = coalesce(p_block_cod, block_cod),
         -- Blocking and trusting are opposites, so setting one clears the other
         -- rather than leaving a row that says both.
         trusted   = case when coalesce(p_block_cod, false) then false
                          else coalesce(p_trusted, trusted) end,
         note      = coalesce(p_note, note),
         updated_at = now()
   where tenant_id = p_tenant_id and phone_digits = v_digits;

  return public.buyer_risk_lookup(p_tenant_id, p_phone);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording a return
-- ---------------------------------------------------------------------------
/**
 * The parcel came back. Record it, put the stock away, count the cost.
 *
 * One call, because these three things must not be able to happen separately. A
 * seller who moves an order to RTS and forgets to restock has inventory that says
 * they are sold out of something sitting in a box by the door; a seller who
 * restocks without recording the cost cannot see that COD to that province loses
 * money.
 *
 * **`packer`, not `staff`.** Receiving a returned parcel is warehouse work, and it
 * is the same hierarchy lesson phase 9 learned: `packer` ranks *below* `staff`, so
 * guarding this with `staff` would lock out the role that physically opens the box.
 * Deciding to *waive* the buyer's fee or issue a refund stays `staff` — that is a
 * commercial decision and it lives on the refund path.
 *
 * Restocking is opt-in per call rather than automatic, because a returned parcel is
 * not always saleable: it has been on a van for two weeks, and cosmetics, food and
 * anything with a seal frequently come back as a write-off. Selld cannot tell from
 * here — the person holding the box can.
 */
create or replace function public.record_rts(
  p_order_id    uuid,
  p_reason      text,
  p_restock     boolean default true,
  p_return_cost bigint default null,
  p_note        text default null,
  p_location_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    record;
  v_shipment record;
  v_location uuid;
  v_rts_id   uuid;
  v_item     record;
  v_units    int := 0;
  v_outbound bigint := 0;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'no_data_found';
  end if;

  if not public.has_tenant_role(v_order.tenant_id, 'packer') then
    raise exception 'Not allowed to record returns for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if v_order.fulfillment_status in ('delivered', 'cancelled') then
    raise exception 'That order is already %', v_order.fulfillment_status
      using errcode = 'check_violation', hint = 'terminal_status';
  end if;

  -- Idempotent by the order's own state. Two packers opening the same box, or a
  -- double-tap on a phone, must not double-restock — which would silently invent
  -- inventory that does not exist.
  if exists (select 1 from public.order_rts where order_id = p_order_id) then
    return jsonb_build_object('outcome', 'already_recorded',
      'rtsId', (select id from public.order_rts where order_id = p_order_id limit 1));
  end if;

  select * into v_shipment from public.shipments
   where order_id = p_order_id and status <> 'cancelled'
   order by created_at desc limit 1;

  v_outbound := coalesce(v_shipment.cost_centavos::bigint, 0);

  -- Back to where it shipped from, or the default location. Not "any location":
  -- restocking into the wrong warehouse is how a picker is sent to an empty shelf.
  v_location := coalesce(
    p_location_id,
    v_order.location_id,
    (select id from public.locations
      where tenant_id = v_order.tenant_id and is_default order by created_at limit 1),
    (select id from public.locations
      where tenant_id = v_order.tenant_id order by created_at limit 1));

  insert into public.order_rts
    (tenant_id, order_id, shipment_id, reason, note,
     outbound_cost_centavos, return_cost_centavos, restocked, location_id, recorded_by)
  values (v_order.tenant_id, p_order_id, v_shipment.id, p_reason, p_note,
          v_outbound,
          -- A courier that charged to deliver charges again to bring it back.
          -- Defaulting to the outbound cost is the honest guess; the seller can
          -- correct it when the statement arrives.
          coalesce(p_return_cost, v_outbound),
          p_restock and v_location is not null, v_location, auth.uid())
  returning id into v_rts_id;

  -- ---- The goods ---------------------------------------------------------
  if p_restock and v_location is not null then
    for v_item in
      select variant_id, qty from public.order_items
      where order_id = p_order_id and variant_id is not null
    loop
      -- Through the ledger, never by writing `inventory_levels` — the trigger
      -- maintains `on_hand` and a guard rejects direct writes.
      insert into public.stock_movements
        (tenant_id, variant_id, location_id, delta, reason,
         reference_type, reference_id, note, created_by)
      values (v_order.tenant_id, v_item.variant_id, v_location, v_item.qty, 'rts',
              'order', p_order_id,
              format('RTS %s', v_order.order_number), auth.uid());
      v_units := v_units + v_item.qty;
    end loop;
  end if;

  -- ---- The order ---------------------------------------------------------
  if v_order.fulfillment_status <> 'rts' then
    update public.orders set fulfillment_status = 'rts' where id = p_order_id;
    insert into public.order_status_history
      (tenant_id, order_id, field, from_status, to_status, actor_id, note)
    values (v_order.tenant_id, p_order_id, 'fulfillment_status',
            v_order.fulfillment_status, 'rts', auth.uid(),
            coalesce(p_note, format('RTS: %s', p_reason)));
  end if;

  -- ---- The buyer ---------------------------------------------------------
  perform public.buyer_risk_refresh(v_order.tenant_id, v_order.contact_phone);

  return jsonb_build_object(
    'outcome',      'recorded',
    'rtsId',        v_rts_id,
    'restocked',    p_restock and v_location is not null,
    'unitsReturned', v_units,
    'costCentavos', v_outbound + coalesce(p_return_cost, v_outbound),
    'buyerRisk',    public.buyer_risk_lookup(v_order.tenant_id, v_order.contact_phone));
end;
$$;

/**
 * Correct the return cost once the courier's statement says what it really was.
 *
 * Separate from `record_rts` because the two facts arrive weeks apart: the box comes
 * back today, the invoice for bringing it back comes with the next payout.
 */
create or replace function public.update_rts_cost(
  p_rts_id      uuid,
  p_return_cost bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_rts record;
begin
  select * into v_rts from public.order_rts where id = p_rts_id;
  if v_rts.id is null then
    raise exception 'Return not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_rts.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_return_cost is null or p_return_cost < 0 then
    raise exception 'A return cost cannot be negative'
      using errcode = 'check_violation';
  end if;

  update public.order_rts set return_cost_centavos = p_return_cost where id = p_rts_id;
  return jsonb_build_object('rtsId', p_rts_id, 'returnCost', p_return_cost);
end;
$$;

/**
 * The RTS ledger: what came back, what it cost, and who keeps sending it back.
 *
 * The per-buyer table at the end is the one that changes behaviour. A seller
 * looking at "₱4,300 of returns this month" shrugs; a seller looking at three phone
 * numbers responsible for a third of it starts asking those buyers to pay up front.
 */
create or replace function public.rts_report(
  p_tenant_id uuid,
  p_days      int default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  v_since := now() - make_interval(days => greatest(least(coalesce(p_days, 90), 365), 1));

  return jsonb_build_object(
    'sinceDays', greatest(least(coalesce(p_days, 90), 365), 1),
    'count', (select count(*)::int from public.order_rts
               where tenant_id = p_tenant_id and created_at >= v_since),
    'cost',  (select coalesce(sum(outbound_cost_centavos::bigint
                               + return_cost_centavos::bigint), 0)
              from public.order_rts
              where tenant_id = p_tenant_id and created_at >= v_since),
    'valueReturned', (select coalesce(sum(o.grand_total_centavos::bigint), 0)
                      from public.order_rts r join public.orders o on o.id = r.order_id
                      where r.tenant_id = p_tenant_id and r.created_at >= v_since),
    'restockedCount', (select count(*)::int from public.order_rts
                        where tenant_id = p_tenant_id and created_at >= v_since and restocked),
    'byReason', coalesce((
      select jsonb_agg(jsonb_build_object('reason', reason, 'count', n, 'cost', cost)
             order by n desc)
      from (select reason, count(*)::int as n,
                   sum(outbound_cost_centavos::bigint + return_cost_centavos::bigint) as cost
            from public.order_rts
            where tenant_id = p_tenant_id and created_at >= v_since
            group by reason) g), '[]'::jsonb),
    -- Where the returns come from. Province-level, because that is the grain a
    -- seller can act on: "stop offering COD to X" is a real decision.
    'byProvince', coalesce((
      select jsonb_agg(jsonb_build_object('province', province, 'count', n, 'cost', cost)
             order by n desc)
      from (select coalesce(o.shipping_address ->> 'provinceName',
                            o.shipping_address ->> 'cityName', 'Unknown') as province,
                   count(*)::int as n,
                   sum(r.outbound_cost_centavos::bigint
                       + r.return_cost_centavos::bigint) as cost
            from public.order_rts r join public.orders o on o.id = r.order_id
            where r.tenant_id = p_tenant_id and r.created_at >= v_since
            group by 1 order by 2 desc limit 15) g), '[]'::jsonb),
    'repeatOffenders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phoneDigits', phone_digits, 'orders', orders_count,
        'delivered', delivered_count, 'rts', rts_count,
        'rtsRateBps', rts_rate_bps, 'blockCod', block_cod, 'note', note)
        order by rts_count desc, rts_rate_bps desc)
      from (select * from public.buyer_risk_flags
            where tenant_id = p_tenant_id and rts_count > 0
            order by rts_count desc, rts_rate_bps desc limit 25) f), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Keeping the risk score honest
-- ---------------------------------------------------------------------------
/**
 * Refresh a buyer's risk row whenever one of their orders reaches a conclusion.
 *
 * A trigger rather than a call inside `orders_bulk_transition`, because there is
 * more than one way an order reaches `delivered`: the packer's bulk action, a
 * courier scan through `record_shipment_event`, and a manual correction. Three call
 * sites is three chances to forget one, and a risk score that is right except when
 * the courier reported it is worse than no score.
 *
 * Only fires on the two statuses that end the story. `pending -> confirmed` is not
 * evidence about a buyer.
 */
create or replace function public.orders_refresh_buyer_risk()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.fulfillment_status is distinct from old.fulfillment_status
     and new.fulfillment_status in ('delivered', 'rts') then
    perform public.buyer_risk_refresh(new.tenant_id, new.contact_phone);
  end if;
  return null;
end;
$$;

create trigger orders_buyer_risk
  after update of fulfillment_status on public.orders
  for each row execute function public.orders_refresh_buyer_risk();

-- ---------------------------------------------------------------------------
-- checkout_place_order — a blocked buyer cannot choose COD
-- ---------------------------------------------------------------------------
/**
 * Reproduced in full for the same reason phase 8 reproduced it: `create or replace
 * function` has no way to patch a body. Only the buyer-risk gate is new; every
 * other line was generated from the live function, so the untouched parts are
 * byte-identical rather than retyped.
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

  update public.customers
     set total_orders = total_orders + 1,
         total_spent_centavos = total_spent_centavos + (v_pricing ->> 'grandTotal')::bigint
   where id = v_customer_id;

  return public.order_receipt(v_order_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.cod_remittances       enable row level security;
alter table public.cod_remittances       force  row level security;
alter table public.cod_remittance_lines  enable row level security;
alter table public.cod_remittance_lines  force  row level security;
alter table public.order_rts             enable row level security;
alter table public.order_rts             force  row level security;
alter table public.buyer_risk_flags      enable row level security;
alter table public.buyer_risk_flags      force  row level security;

-- The pool has no tenant column and therefore no tenant policy. RLS on with no
-- policy at all means "nobody, by any route except a definer" — which is exactly
-- the intent, and stronger than a policy that could be widened by accident.
alter table public.buyer_risk_signals       enable row level security;
alter table public.buyer_risk_signals       force  row level security;
alter table public.buyer_risk_contributions enable row level security;
alter table public.buyer_risk_contributions force  row level security;

create policy "Members read remittances" on public.cod_remittances for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read remittance lines" on public.cod_remittance_lines
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Members read returns" on public.order_rts for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read buyer risk" on public.buyer_risk_flags for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Read-only everywhere. Every write on this surface moves money or inventory and
-- goes through a function that checks a role first — a seller who could
-- `update cod_remittance_lines set match_status = 'matched'` could mark an
-- unremitted parcel paid without a courier ever paying.
grant select on public.cod_remittances      to authenticated;
grant select on public.cod_remittance_lines to authenticated;
grant select on public.order_rts            to authenticated;
grant select on public.buyer_risk_flags     to authenticated;

grant execute on function public.cod_import_statement(uuid, text, jsonb, text, text, bigint) to authenticated;
grant execute on function public.cod_remittance_summary(uuid)         to authenticated;
grant execute on function public.cod_remittance_lines(uuid, boolean, int) to authenticated;
grant execute on function public.cod_post_remittance(uuid)            to authenticated;
grant execute on function public.cod_discard_remittance(uuid)         to authenticated;
grant execute on function public.cod_reconciliation(uuid, int)        to authenticated;
grant execute on function public.record_rts(uuid, text, boolean, bigint, text, uuid) to authenticated;
grant execute on function public.update_rts_cost(uuid, bigint)        to authenticated;
grant execute on function public.rts_report(uuid, int)                to authenticated;
grant execute on function public.buyer_risk_lookup(uuid, text)        to authenticated;
grant execute on function public.buyer_risk_set_flag(uuid, text, boolean, boolean, text) to authenticated;

/**
 * Not callable by anyone, and `from public` first.
 *
 * `revoke ... from anon, authenticated` would be a no-op: Postgres grants EXECUTE
 * on every new function to PUBLIC, and revoking from a role does not remove a
 * privilege it holds *through* PUBLIC. That is how `record_payment_event` shipped
 * anon-callable in phase 8. `\dp` shows the tell — `=X/postgres`, empty grantee.
 *
 * These three are the pseudonymity boundary. `buyer_risk_hash` would let a caller
 * confirm whether a given phone number is in the shared pool, one number at a time,
 * which is the entire property the hashing exists to protect. `buyer_risk_contribute`
 * writes the pool. `buyer_risk_refresh` derives a row from another tenant's orders
 * if handed their id.
 *
 * No `grant ... to service_role` either, unlike phases 8 and 10: nothing outside
 * the database calls these. If that changes, grant explicitly and assert both
 * directions in CI — a revoke that goes too far is as dead as one that does not go
 * far enough.
 */
revoke all on function public.buyer_risk_hash(text)                   from public;
revoke all on function public.buyer_risk_contribute(uuid, text, int, int, int) from public;
revoke all on function public.buyer_risk_refresh(uuid, text)          from public;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
-- Both default to off. Contributing a buyer's history to a shared pool is a
-- decision a seller makes knowingly or not at all, however anonymised the pool is.
insert into public.tenant_settings (tenant_id, key, value)
select t.id, k.key, k.value
from public.tenants t
cross join (values
  ('risk.contribute_signal', 'false'::jsonb),
  ('risk.use_shared_signal', 'false'::jsonb)
) as k(key, value)
on conflict (tenant_id, key) do nothing;

-- New tenants get them too. The backfill above only covers stores that already
-- exist — the phase-8 mistake where `payments.methods` was backfilled and not
-- seeded, so every store created afterwards offered no online payment at all.
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
    -- Phase 8. Which online methods the checkout page offers, intersected with
    -- whether the tenant has actually connected a payment account.
    (new.id, 'payments.methods', '["gcash","maya","grabpay","qrph","card"]'::jsonb),
    (new.id, 'orders.number_prefix', '""'::jsonb),
    (new.id, 'orders.auto_confirm', 'false'::jsonb),
    (new.id, 'catalog.presets', '[]'::jsonb),
    -- Phase 6. ₱80 is the going rate for Metro Manila small-parcel COD, and a
    -- default of 0 would silently ship everything free.
    (new.id, 'shipping.flat_centavos', '8000'::jsonb),
    -- Phase 12. Both off: sharing a buyer's history with other stores is a
    -- decision a seller makes knowingly or not at all.
    (new.id, 'risk.contribute_signal', 'false'::jsonb),
    (new.id, 'risk.use_shared_signal', 'false'::jsonb)
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
$$;

comment on table public.cod_remittances is
  'One imported courier payout statement. Draft until posted; posting is what marks orders paid.';
comment on table public.cod_remittance_lines is
  'One statement row, with what Selld decided it means. Only matched and variance lines post.';
comment on table public.order_rts is
  'A returned parcel: why, what it cost both ways, and whether the stock came back.';
comment on table public.buyer_risk_flags is
  'RTS rate per phone number per tenant. The score is computed; block_cod is a seller decision.';
comment on table public.buyer_risk_signals is
  'The same signal pooled across tenants, keyed by a salted hash. Opt-in both ways, no tenant column.';
