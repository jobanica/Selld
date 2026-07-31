-- ===========================================================================
-- Phase 13 — Live selling capture
-- ===========================================================================
--
-- The wedge feature. A Filipino social seller goes live on Facebook, holds up an
-- item, says "A1 po ito, five hundred", and the comments arrive faster than anyone
-- can read them. Today somebody writes them in a notebook, then types the notebook
-- into a spreadsheet, then types the spreadsheet into a courier's booking form.
-- That transcription is where the evening's profit goes: a missed claim is a lost
-- sale, a mis-keyed one is a parcel sent to the wrong person, and a double-entered
-- one oversells stock that is not there.
--
-- **Done when:** a 200-comment live session produces correct orders with zero
-- manual encoding.
--
-- ## The shape of it
--
-- `live_sessions`  one broadcast, with a claim window and whatever is on screen
-- `live_items`     a claim code (A1, B10) pointing at a variant
-- `live_comments`  every comment as received, deduplicated, with what it parsed to
-- `live_claims`    a parsed claim that is holding stock, and what became of it
--
-- ## Where the work happens, and why it is split that way
--
-- **Parsing is in TypeScript** (`src/core/live/parser.ts`), because it is a pile of
-- Taglish and Bisaya heuristics that needs a scored corpus and a fast edit loop,
-- and because it is pure — the same function scores the corpus, replays a log and
-- runs live.
--
-- **Reserving is in SQL**, because holding stock is the thing that must not be
-- wrong under concurrency. Thirty buyers claiming the last two units of A1 in the
-- same second is the normal case, not the edge case, and phase 4's advisory-lock
-- reservation already solved it.
--
-- So `live_ingest_comment` takes the *parse* as an argument and does not trust it
-- for anything except which variant and how many: the claim code is resolved
-- against this session's own items, the quantity is clamped, and the reservation
-- goes through `reserve_stock` exactly as the dashboard's would.

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
/**
 * One live broadcast.
 *
 * `current_item_id` is the item the seller has in their hands right now, and it is
 * load-bearing rather than cosmetic: the single most common comment in a Philippine
 * live sale is the word "mine" with nothing else in it, and it means "the thing you
 * are holding". Without this column that comment is unparseable, and it is most of
 * the traffic.
 *
 * `claim_window_minutes` is how long a claim holds stock before it goes back on
 * sale. Sellers run 15 minutes to a couple of hours; the default is deliberately
 * short, because stock held for a buyer who has stopped replying is stock the next
 * buyer was told was sold out.
 */
create table public.live_sessions (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  title  text not null check (length(btrim(title)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'live', 'ended')),

  /** Where claims reserve from. Defaults to the tenant's default location. */
  location_id uuid,

  /** Where the comments come from. `manual` is the operator typing them in. */
  channel text not null default 'facebook'
    check (channel in ('facebook', 'instagram', 'tiktok', 'manual')),
  /** The Facebook live-video or post id this session listens to. */
  external_ref text,

  claim_window_minutes int not null default 30
    check (claim_window_minutes between 5 and 1440),

  current_item_id uuid,

  started_at timestamptz,
  ended_at   timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete set null
);

create index live_sessions_tenant_idx on public.live_sessions (tenant_id, created_at desc);
-- One session per broadcast. A second subscription to the same live video would
-- otherwise double every claim in it.
create unique index live_sessions_external_idx
  on public.live_sessions (tenant_id, channel, external_ref)
  where external_ref is not null and status <> 'ended';

create trigger live_sessions_touch
  before update on public.live_sessions
  for each row execute function public.set_updated_at();

/**
 * A claim code, pointing at a variant.
 *
 * `allocated_qty` is how many of the seller's stock this session is putting up.
 * Null means "whatever is in stock" — which is what a seller running one live sale
 * at a time wants — and a number is for the seller who is holding half the stock
 * back for their shop.
 *
 * The code is stored as the seller typed it and matched case-insensitively, because
 * a buyer types `a1` and the seller wrote `A1`, and neither is wrong.
 */
create table public.live_items (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null,
  variant_id uuid not null,

  claim_code text not null check (claim_code ~ '^[A-Za-z]{1,2}[0-9]{1,3}$'),
  allocated_qty int check (allocated_qty > 0),
  sort_order int not null default 0,

  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, session_id)
    references public.live_sessions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete cascade
);

-- Codes are unique within a session, case-insensitively. Two items both called
-- `A1` would make every claim on A1 ambiguous, and the parser cannot help.
create unique index live_items_code_idx
  on public.live_items (session_id, upper(claim_code));
create index live_items_session_idx on public.live_items (tenant_id, session_id, sort_order);

alter table public.live_sessions
  add constraint live_sessions_current_item_fkey
  foreign key (tenant_id, current_item_id)
  references public.live_items (tenant_id, id) on delete set null;

/**
 * Every comment, as received.
 *
 * Kept in full even when it is not a claim, for three reasons that all turned out
 * to matter: the operator needs to see the questions ("magkano po?") to answer
 * them, an unmatched comment is how a seller notices the parser is wrong, and a
 * replay of a real session is the only honest way to measure parse accuracy.
 *
 * `external_id` is Facebook's comment id, and the unique index on it is the
 * idempotency boundary. Facebook redelivers webhooks; a redelivered comment that
 * claimed stock a second time would oversell an item while the seller watched.
 */
create table public.live_comments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null,

  /** Facebook's comment id, or a synthetic one for a manually typed comment. */
  external_id text not null,
  /** Page-scoped user id. The same buyer across a page, and only that page. */
  psid        text not null,
  author_name text,
  body        text not null,

  /** What the parser made of it, kept so a wrong parse can be seen and fixed. */
  parsed jsonb,
  outcome text not null default 'pending' check (
    outcome in ('pending', 'claimed', 'not_a_claim', 'unknown_code',
                'no_item_on_screen', 'sold_out', 'duplicate')
  ),

  received_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (session_id, external_id),
  foreign key (tenant_id, session_id)
    references public.live_sessions (tenant_id, id) on delete cascade
);

create index live_comments_session_idx
  on public.live_comments (tenant_id, session_id, received_at desc);

/**
 * A claim that is holding stock.
 *
 * The lifecycle, and the money at each step:
 *
 *   reserved   stock is held; the buyer has a checkout link and a deadline
 *   converted  they checked out; the order owns the stock now
 *   expired    the window closed; the reservation went back
 *   cancelled  the operator rejected it, or the buyer said never mind
 *
 * `cart_id` is how the checkout link works: a claim mints a cart, the link carries
 * that cart's token, and the buyer lands on a checkout page with the right item
 * already in it. Nothing about the price lives here — `cart_pricing()` is still the
 * only place money is computed, so a live claim and a normal cart cannot disagree.
 */
create table public.live_claims (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null,
  item_id    uuid not null,
  comment_id uuid,

  psid       text not null,
  buyer_name text,
  qty        int not null check (qty between 1 and 20),

  status text not null default 'reserved'
    check (status in ('reserved', 'converted', 'expired', 'cancelled')),

  cart_id  uuid,
  order_id uuid,

  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,

  unique (tenant_id, id),
  foreign key (tenant_id, session_id)
    references public.live_sessions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id)
    references public.live_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, comment_id)
    references public.live_comments (tenant_id, id) on delete set null,
  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete set null
);

create index live_claims_session_idx
  on public.live_claims (tenant_id, session_id, created_at desc);
-- The expiry sweep reads exactly this.
create index live_claims_expiry_idx
  on public.live_claims (expires_at) where status = 'reserved';
create index live_claims_item_idx on public.live_claims (item_id, status);

-- ---------------------------------------------------------------------------
-- Reserving without a signed-in caller
-- ---------------------------------------------------------------------------
/**
 * Hold stock, with no authorisation at all.
 *
 * The same split as `apply_reservation` in phase 6 and `sms_credit_balance_raw` in
 * phase 11, and for the same reason: a comment arriving on a Facebook webhook has
 * no JWT, so `reserve_stock`'s membership check would refuse every claim in a live
 * session. Reimplementing the reservation here instead would duplicate the sorted
 * advisory locks that phase 4 needed three attempts to get right, and a second
 * copy is a second thing to get wrong.
 *
 * Not granted to anyone. The only callers are the `SECURITY DEFINER` functions that
 * have already decided the caller is allowed — `reserve_stock` (membership) and
 * `live_ingest_comment` (the session's own webhook secret).
 *
 * The body is phase 4's, unchanged: locks taken in sorted order so two comments
 * claiming {A,B} and {B,A} cannot deadlock, and the availability test inside the
 * UPDATE predicate so the read and the write are one atomic statement.
 */
create or replace function public.reserve_stock_raw(
  p_tenant_id      uuid,
  p_location_id    uuid,
  p_items          jsonb
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
        using errcode = 'check_violation', hint = 'insufficient_stock';
    end if;
  end loop;
end;
$$;

/**
 * Give stock back, with no authorisation.
 *
 * The mirror of `reserve_stock_raw`, and needed on two paths that have no signed-in
 * caller: the expiry sweep (a cron with a service key) and the trigger that settles
 * a claim when the *buyer* checks out — that one runs inside a guest's transaction,
 * where a membership check is guaranteed to be false.
 *
 * `greatest(..., 0)` for the same reason phase 4 has it: a double-release must not
 * drive `reserved` negative and silently invent availability.
 */
create or replace function public.release_reservation_raw(
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
    update public.inventory_levels
       set reserved = greatest(reserved - v_item.qty, 0)
     where variant_id = v_item.variant_id
       and location_id = p_location_id
       and tenant_id = p_tenant_id;
  end loop;
end;
$$;

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
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not a member of this tenant' using errcode = 'insufficient_privilege';
  end if;
  perform public.release_reservation_raw(p_tenant_id, p_location_id, p_items);
end;
$$;

-- The dashboard's entry point keeps its membership check and delegates the
-- mechanics, so there is exactly one implementation of "hold this stock".
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
  perform public.reserve_stock_raw(p_tenant_id, p_location_id, p_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- Running a session
-- ---------------------------------------------------------------------------
/** Start a session. Codes are added one at a time as the seller sets up. */
create or replace function public.live_session_create(
  p_tenant_id uuid,
  p_title     text,
  p_channel   text default 'facebook',
  p_external_ref text default null,
  p_window_minutes int default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_location uuid;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to run live sessions for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  -- The default location if there is one, otherwise the oldest — the same rule
  -- `checkout_place_order` uses. Taking only `is_default` leaves `location_id`
  -- null for a store that never flagged one, and a null location reserves against
  -- no row at all: every claim in the session comes back `sold_out` while the
  -- shelf is full, and nothing anywhere says why.
  select id into v_location from public.locations
   where tenant_id = p_tenant_id
   order by is_default desc, created_at
   limit 1;

  if v_location is null then
    raise exception 'This store has no stock location to sell from'
      using errcode = 'feature_not_supported', hint = 'no_location';
  end if;

  insert into public.live_sessions
    (tenant_id, title, channel, external_ref, claim_window_minutes, location_id, created_by)
  values (p_tenant_id, p_title, p_channel, nullif(btrim(coalesce(p_external_ref, '')), ''),
          coalesce(p_window_minutes, 30), v_location, auth.uid())
  returning id into v_id;

  return public.live_console(v_id);
end;
$$;

/** Put a variant on the board under a claim code. */
create or replace function public.live_item_add(
  p_session_id uuid,
  p_variant_id uuid,
  p_claim_code text,
  p_allocated  int default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
begin
  select * into v_session from public.live_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_session.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.live_items
    (tenant_id, session_id, variant_id, claim_code, allocated_qty, sort_order)
  values (v_session.tenant_id, p_session_id, p_variant_id, upper(btrim(p_claim_code)),
          p_allocated,
          coalesce((select max(sort_order) + 1 from public.live_items
                     where session_id = p_session_id), 0));

  return public.live_console(p_session_id);
end;
$$;

/**
 * Change what the seller is holding up, or go live, or end.
 *
 * One function for the three things an operator does between claims, because they
 * happen in the same half-second and each one being its own round trip is latency
 * a person notices while a hundred people watch them.
 */
create or replace function public.live_session_update(
  p_session_id uuid,
  p_status     text default null,
  p_current_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_item    uuid;
begin
  select * into v_session from public.live_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_session.tenant_id, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  if p_current_code is not null then
    select id into v_item from public.live_items
     where session_id = p_session_id and upper(claim_code) = upper(btrim(p_current_code));
    if v_item is null and btrim(p_current_code) <> '' then
      raise exception 'No item with code % in this session', p_current_code
        using errcode = 'no_data_found', hint = 'unknown_code';
    end if;
  end if;

  update public.live_sessions
     set status = coalesce(p_status, status),
         current_item_id = case when p_current_code is null then current_item_id
                                when btrim(p_current_code) = '' then null
                                else v_item end,
         started_at = case when p_status = 'live' then coalesce(started_at, now())
                           else started_at end,
         ended_at   = case when p_status = 'ended' then now() else ended_at end
   where id = p_session_id;

  -- Ending a session releases everything still held. Stock sitting reserved for a
  -- broadcast that finished two hours ago is stock the shop cannot sell.
  if p_status = 'ended' then
    perform public.live_expire_claims(p_session_id, true);
  end if;

  return public.live_console(p_session_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ingesting a comment
-- ---------------------------------------------------------------------------
/**
 * Record one comment and turn its parse into held stock.
 *
 * `p_claims` is what `parseComment()` made of the body: `[{code, qty}]`. That is an
 * *assertion from a client*, and it is trusted for exactly two things — which code
 * and how many — both of which are then re-checked here: the code is resolved
 * against this session's own items, and the quantity goes through `reserve_stock_raw`,
 * which refuses to hold stock that is not there.
 *
 * Order of operations, and it is the safety property:
 *
 *   1. insert the comment       <- unique (session_id, external_id)
 *   2. if that conflicted, return 'duplicate' and touch nothing else
 *   3. only then reserve stock and write claims
 *
 * Step 2 is why a redelivered Facebook webhook does not claim the same item twice.
 * Facebook redelivers routinely, and an oversold live session is one the seller has
 * to unwind by hand while a hundred people watch.
 *
 * A claim that cannot be filled is not an error: it is recorded as `sold_out`, the
 * comment is kept, and the operator sees it. Raising would abort the whole comment,
 * including the claims that *could* be filled.
 */
create or replace function public.live_ingest_comment(
  p_session_id  uuid,
  p_external_id text,
  p_psid        text,
  p_body        text,
  p_claims      jsonb default '[]'::jsonb,
  p_reason      text default 'claimed',
  p_author_name text default null,
  p_unknown_codes jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  record;
  v_comment  uuid;
  v_claim    record;
  v_item     record;
  v_qty      int;
  v_held     int;
  v_cart_id  uuid;
  v_token    text;
  v_results  jsonb := '[]'::jsonb;
  v_outcome  text;
  v_any      boolean := false;
  v_soldout  boolean := false;
begin
  select * into v_session from public.live_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;

  -- ---- 1 & 2. De-duplicate before anything is applied --------------------
  insert into public.live_comments
    (tenant_id, session_id, external_id, psid, author_name, body, parsed, outcome)
  values (v_session.tenant_id, p_session_id, p_external_id, p_psid, p_author_name, p_body,
          jsonb_build_object('claims', p_claims, 'reason', p_reason,
                             'unknownCodes', p_unknown_codes),
          'pending')
  on conflict (session_id, external_id) do nothing
  returning id into v_comment;

  if v_comment is null then
    return jsonb_build_object('outcome', 'duplicate', 'claims', '[]'::jsonb);
  end if;

  -- A session that is not live records the comment and holds nothing. Stock must
  -- not be reserved by a webhook arriving after the seller has gone off air.
  if v_session.status <> 'live' then
    update public.live_comments set outcome = 'not_a_claim' where id = v_comment;
    return jsonb_build_object('outcome', 'not_live', 'commentId', v_comment,
                              'claims', '[]'::jsonb);
  end if;

  -- ---- 3. Each claim in the comment ---------------------------------------
  for v_claim in
    select upper(btrim(value ->> 'code')) as code,
           greatest(least(coalesce((value ->> 'qty')::int, 1), 20), 1) as qty
    from jsonb_array_elements(p_claims) as value
  loop
    select * into v_item from public.live_items
     where session_id = p_session_id and upper(claim_code) = v_claim.code;

    if v_item.id is null then
      -- The client claimed a code this session does not sell. It cannot invent one.
      v_results := v_results || jsonb_build_object('code', v_claim.code, 'outcome', 'unknown_code');
      continue;
    end if;

    -- The seller's own allocation for this session, if they set one. Held claims
    -- count against it, converted ones stay counted — both are units spoken for.
    if v_item.allocated_qty is not null then
      select coalesce(sum(qty), 0)::int into v_held from public.live_claims
       where item_id = v_item.id and status in ('reserved', 'converted');
      if v_held + v_claim.qty > v_item.allocated_qty then
        v_soldout := true;
        v_results := v_results || jsonb_build_object(
          'code', v_claim.code, 'outcome', 'sold_out', 'reason', 'allocation');
        continue;
      end if;
    end if;

    begin
      perform public.reserve_stock_raw(
        v_session.tenant_id, v_session.location_id,
        jsonb_build_array(jsonb_build_object(
          'variant_id', v_item.variant_id, 'qty', v_claim.qty)));
    exception when others then
      -- Out of stock is the ordinary case at the end of a live sale, not a fault.
      -- Recorded and shown; the rest of the comment still goes through.
      v_soldout := true;
      v_results := v_results || jsonb_build_object(
        'code', v_claim.code, 'outcome', 'sold_out', 'reason', 'stock');
      continue;
    end;

    -- A cart per claim, so the checkout link lands on a page with the right item
    -- already in it. `cart_pricing()` still computes every peso — a live claim and
    -- a normal cart cannot disagree about what something costs.
    insert into public.carts (tenant_id, token, status, expires_at, source)
    values (v_session.tenant_id, encode(extensions.gen_random_bytes(32), 'hex'), 'active',
            now() + make_interval(mins => v_session.claim_window_minutes * 4), 'live')
    returning id, token into v_cart_id, v_token;

    insert into public.cart_items
      (tenant_id, cart_id, variant_id, qty, unit_price_centavos)
    select v_session.tenant_id, v_cart_id, v_item.variant_id, v_claim.qty, v.price_centavos
    from public.product_variants v where v.id = v_item.variant_id;

    insert into public.live_claims
      (tenant_id, session_id, item_id, comment_id, psid, buyer_name, qty,
       cart_id, expires_at)
    values (v_session.tenant_id, p_session_id, v_item.id, v_comment, p_psid,
            p_author_name, v_claim.qty, v_cart_id,
            now() + make_interval(mins => v_session.claim_window_minutes));

    v_any := true;
    v_results := v_results || jsonb_build_object(
      'code', v_claim.code, 'outcome', 'reserved', 'qty', v_claim.qty,
      'cartToken', v_token);
  end loop;

  v_outcome := case
    when v_any then 'claimed'
    when v_soldout then 'sold_out'
    when jsonb_array_length(p_claims) > 0 then 'unknown_code'
    else p_reason
  end;

  update public.live_comments set outcome = v_outcome where id = v_comment;

  return jsonb_build_object(
    'outcome', v_outcome, 'commentId', v_comment, 'claims', v_results);
end;
$$;

/**
 * The operator's own comment box.
 *
 * A checked wrapper over `live_ingest_comment`, which is service-role only because
 * the webhook is the thing that normally calls it — and a function that reserves a
 * seller's stock for an account-less buyer must not be callable by every signed-in
 * user with a session id to guess.
 *
 * The wrapper exists because a seller running the `manual` channel *is* the ingest:
 * no Facebook app connected, watching their own comments, typing the ones that
 * matter. Same function underneath, so a rehearsal exercises the code that runs on
 * the night — which was the whole point of putting the parse in one place.
 */
create or replace function public.live_ingest_manual(
  p_session_id  uuid,
  p_external_id text,
  p_psid        text,
  p_body        text,
  p_claims      jsonb default '[]'::jsonb,
  p_reason      text default 'claimed',
  p_author_name text default null,
  p_unknown_codes jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.live_sessions where id = p_session_id;
  if v_tenant is null then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_tenant, 'staff') then
    raise exception 'Not allowed to add comments to this session'
      using errcode = 'insufficient_privilege';
  end if;

  return public.live_ingest_comment(p_session_id, p_external_id, p_psid, p_body,
    p_claims, p_reason, p_author_name, p_unknown_codes);
end;
$$;

-- ---------------------------------------------------------------------------
-- Letting go
-- ---------------------------------------------------------------------------
/**
 * Release claims whose window has closed.
 *
 * The counterweight to reserving: without it a live sale ends with every unsold
 * item still marked reserved, and the shop shows sold out for days.
 *
 * `p_all` releases everything still held regardless of deadline, which is what
 * ending a session does.
 *
 * Only touches rows still in `reserved`. A claim that already became an order owns
 * its stock through the order now, and releasing it again would hand the same units
 * out twice.
 */
create or replace function public.live_expire_claims(
  p_session_id uuid default null,
  p_all        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim record;
  v_count int := 0;
  v_units int := 0;
begin
  for v_claim in
    select c.*, s.location_id, i.variant_id
    from public.live_claims c
      join public.live_sessions s on s.id = c.session_id
      join public.live_items i on i.id = c.item_id
    where c.status = 'reserved'
      and (p_session_id is null or c.session_id = p_session_id)
      and (p_all or c.expires_at <= now())
    -- Locked in a stable order so a sweep and a checkout racing on the same claim
    -- serialise rather than deadlock.
    order by c.id
    for update of c
  loop
    perform public.release_reservation_raw(
      v_claim.tenant_id, v_claim.location_id,
      jsonb_build_array(jsonb_build_object('variant_id', v_claim.variant_id,
                                           'qty', v_claim.qty)));

    update public.live_claims
       set status = 'expired', settled_at = now()
     where id = v_claim.id;

    -- The cart goes with it. A checkout link that still works after the hold is
    -- gone sells stock the seller has already promised to somebody else.
    update public.carts set status = 'abandoned' where id = v_claim.cart_id;

    v_count := v_count + 1;
    v_units := v_units + v_claim.qty;
  end loop;

  return jsonb_build_object('expired', v_count, 'unitsReleased', v_units);
end;
$$;

/**
 * The operator's decision on one claim.
 *
 * `cancel` is what a seller does when a buyer says "sorry po, mistake" — it
 * releases the hold immediately rather than making everyone wait out the window.
 */
create or replace function public.live_claim_cancel(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim record;
begin
  select c.*, s.location_id, s.tenant_id as t, i.variant_id
    into v_claim
  from public.live_claims c
    join public.live_sessions s on s.id = c.session_id
    join public.live_items i on i.id = c.item_id
  where c.id = p_claim_id
  for update of c;

  if v_claim.id is null then
    raise exception 'Claim not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_claim.t, 'staff') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_claim.status <> 'reserved' then
    return jsonb_build_object('outcome', 'already_settled', 'status', v_claim.status);
  end if;

  perform public.release_reservation(
    v_claim.t, v_claim.location_id,
    jsonb_build_array(jsonb_build_object('variant_id', v_claim.variant_id,
                                         'qty', v_claim.qty)));

  update public.live_claims set status = 'cancelled', settled_at = now()
   where id = p_claim_id;
  update public.carts set status = 'abandoned' where id = v_claim.cart_id;

  return jsonb_build_object('outcome', 'cancelled');
end;
$$;

/**
 * Settle a claim when its cart becomes an order, and hand the hold over.
 *
 * A trigger on `orders` rather than a call inside `checkout_place_order`, because a
 * live cart is checked out from the storefront like any other — the buyer follows
 * the link and fills in the form, and nothing on that path knows it came from a
 * live session.
 *
 * **The claim's reservation is released here, and that is not a bug.** In this
 * schema an order *reserves*; `ship_reservation` is what later turns the hold into
 * a sale. So by the time this trigger runs, `checkout_place_order` has already
 * taken its own hold through `apply_reservation` and the same unit is reserved
 * twice — once by the claim, once by the order. Releasing the claim's leaves
 * exactly one hold, owned by the order.
 *
 * Getting this backwards (the first attempt did) leaves a phantom reservation for
 * every live sale that converts, and an item shows sold out with stock on the shelf.
 */
create or replace function public.live_claims_follow_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_claim record;
begin
  for v_claim in
    select c.id, c.qty, c.tenant_id, s.location_id, i.variant_id
    from public.live_claims c
      join public.live_sessions s on s.id = c.session_id
      join public.live_items i on i.id = c.item_id
    where c.cart_id = new.cart_id and c.status = 'reserved'
  loop
    perform public.release_reservation_raw(
      v_claim.tenant_id, v_claim.location_id,
      jsonb_build_array(jsonb_build_object('variant_id', v_claim.variant_id,
                                           'qty', v_claim.qty)));

    update public.live_claims
       set status = 'converted', order_id = new.id, settled_at = now()
     where id = v_claim.id;
  end loop;
  return null;
end;
$$;

create trigger orders_settle_live_claims
  after insert on public.orders
  for each row when (new.cart_id is not null)
  execute function public.live_claims_follow_order();

-- ---------------------------------------------------------------------------
-- The operator console
-- ---------------------------------------------------------------------------
/**
 * Everything on the operator's screen, in one round trip.
 *
 * One function rather than five, for the same reason `storefront_home()` is one and
 * more urgently: this is polled every couple of seconds while a person is on
 * camera, and five queries is five chances for one of them to be the slow one.
 *
 * The board is ordered the way a seller reads it — the item on screen first, then
 * the rest in the order they set up — and each row carries what is left, because
 * "how many do I still have of A1" is the question they ask out loud every minute.
 */
create or replace function public.live_console(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session record;
begin
  select * into v_session from public.live_sessions where id = p_session_id;
  if v_session.id is null then return null; end if;
  if not public.is_tenant_member(v_session.tenant_id) then
    raise exception 'Not allowed to watch this session'
      using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'id', v_session.id,
    'title', v_session.title,
    'status', v_session.status,
    'channel', v_session.channel,
    'externalRef', v_session.external_ref,
    'claimWindowMinutes', v_session.claim_window_minutes,
    'currentCode', (select claim_code from public.live_items
                     where id = v_session.current_item_id),
    'startedAt', v_session.started_at,
    'endedAt', v_session.ended_at,

    -- ---- Running total. The number the seller announces at the end. -------
    'totals', (
      select jsonb_build_object(
        'claims',    count(*) filter (where c.status in ('reserved', 'converted')),
        'units',     coalesce(sum(c.qty) filter (where c.status in ('reserved','converted')), 0),
        'buyers',    count(distinct c.psid) filter (where c.status in ('reserved','converted')),
        'converted', count(*) filter (where c.status = 'converted'),
        'expired',   count(*) filter (where c.status = 'expired'),
        -- Value at the variant's live price, which is the only price there is.
        'value', coalesce(sum(c.qty * v.price_centavos::bigint)
                   filter (where c.status in ('reserved','converted')), 0))
      from public.live_claims c
        join public.live_items i on i.id = c.item_id
        join public.product_variants v on v.id = i.variant_id
      where c.session_id = p_session_id),

    -- ---- The board --------------------------------------------------------
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'code', x.claim_code, 'variantId', x.variant_id,
        'name', x.name, 'variantLabel', x.variant_label,
        'price', x.price_centavos,
        'allocated', x.allocated_qty,
        'claimed', x.claimed,
        -- What is left to sell: the allocation if the seller set one, otherwise
        -- what is physically unreserved. Never negative on screen.
        'remaining', greatest(
          coalesce(x.allocated_qty, x.on_hand - x.reserved + x.claimed) - x.claimed, 0),
        -- `coalesce`, because `x.id = null` is NULL rather than false when the
        -- seller has nothing on screen — and a null reaches React as "omit this
        -- attribute", so `aria-pressed` disappears from every row on the board.
        'isCurrent', coalesce(x.id = v_session.current_item_id, false))
        order by coalesce(x.is_current, false) desc, x.sort_order)
      from (
        select i.*, v.price_centavos, p.name,
               v.sku as variant_label,
               coalesce(l.on_hand, 0) as on_hand,
               coalesce(l.reserved, 0) as reserved,
               coalesce((select sum(c.qty)::int from public.live_claims c
                          where c.item_id = i.id
                            and c.status in ('reserved', 'converted')), 0) as claimed,
               coalesce(i.id = v_session.current_item_id, false) as is_current
        from public.live_items i
          join public.product_variants v on v.id = i.variant_id
          join public.products p on p.id = v.product_id
          left join public.inventory_levels l
            on l.variant_id = i.variant_id and l.location_id = v_session.location_id
        where i.session_id = p_session_id
      ) x), '[]'::jsonb),

    -- ---- The claim feed ---------------------------------------------------
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'code', i.claim_code, 'qty', c.qty,
        'psid', c.psid, 'buyerName', c.buyer_name,
        'status', c.status, 'expiresAt', c.expires_at,
        'orderId', c.order_id, 'createdAt', c.created_at,
        'comment', m.body)
        order by c.created_at desc)
      from (select * from public.live_claims
            where session_id = p_session_id
            order by created_at desc limit 100) c
        join public.live_items i on i.id = c.item_id
        left join public.live_comments m on m.id = c.comment_id), '[]'::jsonb),

    -- ---- What the parser could not use ------------------------------------
    -- Questions to answer, and the comments that prove the parser needs work.
    -- A live console that only shows successes is one that hides its own failures.
    'unmatched', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'body', m.body, 'psid', m.psid,
        'authorName', m.author_name, 'outcome', m.outcome,
        'receivedAt', m.received_at)
        order by m.received_at desc)
      from (select * from public.live_comments
            where session_id = p_session_id
              and outcome in ('not_a_claim', 'unknown_code', 'no_item_on_screen', 'sold_out')
            order by received_at desc limit 40) m), '[]'::jsonb)
  );
end;
$$;

/** The seller's sessions, newest first. */
create or replace function public.live_sessions_list(p_tenant_id uuid, p_limit int default 20)
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
      'id', s.id, 'title', s.title, 'status', s.status,
      'startedAt', s.started_at, 'endedAt', s.ended_at, 'createdAt', s.created_at,
      'itemCount', (select count(*)::int from public.live_items where session_id = s.id),
      'claimCount', (select count(*)::int from public.live_claims
                      where session_id = s.id and status in ('reserved','converted')))
      order by s.created_at desc)
    from (select * from public.live_sessions where tenant_id = p_tenant_id
          order by created_at desc limit greatest(least(coalesce(p_limit, 20), 100), 1)) s
  ), '[]'::jsonb);
end;
$$;

/**
 * The session a comment belongs to, by the channel reference it arrived on.
 *
 * The webhook knows a live-video id and nothing else — it has no tenant, because
 * Facebook does not know what a tenant is. This is the only lookup that crosses
 * tenants, which is why it returns an id and a location and nothing about the store.
 */
create or replace function public.live_session_for_ref(p_channel text, p_ref text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'tenantId', s.tenant_id, 'status', s.status,
    'currentCode', (select claim_code from public.live_items where id = s.current_item_id),
    'codes', coalesce((select jsonb_agg(claim_code order by sort_order)
                       from public.live_items where session_id = s.id), '[]'::jsonb))
  from public.live_sessions s
  where s.channel = p_channel and s.external_ref = p_ref and s.status = 'live'
  order by s.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.live_sessions enable row level security;
alter table public.live_sessions force  row level security;
alter table public.live_items    enable row level security;
alter table public.live_items    force  row level security;
alter table public.live_comments enable row level security;
alter table public.live_comments force  row level security;
alter table public.live_claims   enable row level security;
alter table public.live_claims   force  row level security;

create policy "Members read live sessions" on public.live_sessions for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read live items" on public.live_items for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read live comments" on public.live_comments for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read live claims" on public.live_claims for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Staff may delete an item they added by mistake while setting up. Everything else
-- on this surface moves stock and goes through a function.
create policy "Staff remove live items" on public.live_items for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select on public.live_sessions to authenticated;
grant select on public.live_comments to authenticated;
grant select on public.live_claims   to authenticated;
grant select, delete on public.live_items to authenticated;

grant execute on function public.live_session_create(uuid, text, text, text, int) to authenticated;
grant execute on function public.live_item_add(uuid, uuid, text, int)             to authenticated;
grant execute on function public.live_session_update(uuid, text, text)            to authenticated;
grant execute on function public.live_console(uuid)                               to authenticated;
grant execute on function public.live_sessions_list(uuid, int)                    to authenticated;
grant execute on function public.live_claim_cancel(uuid)                          to authenticated;
grant execute on function public.live_ingest_manual(uuid, text, text, text, jsonb, text, text, jsonb) to authenticated;

/**
 * Service-role only, and `from public` first — the phase-8 lesson.
 *
 * `live_ingest_comment` reserves stock for a buyer with no account, on the strength
 * of a webhook. `live_session_for_ref` is the one lookup that crosses tenants.
 * `live_expire_claims` releases holds across every session on the platform.
 * `reserve_stock_raw` and `release_reservation_raw` move holds with no
 * authorisation at all.
 *
 * Each granted back to `service_role` explicitly, because `revoke ... from public`
 * removes it there too — except `reserve_stock_raw`, which nothing outside the
 * database calls and so is granted to nobody.
 */
revoke all on function public.live_ingest_comment(uuid, text, text, text, jsonb, text, text, jsonb) from public;
revoke all on function public.live_session_for_ref(text, text) from public;
revoke all on function public.live_expire_claims(uuid, boolean) from public;
revoke all on function public.reserve_stock_raw(uuid, uuid, jsonb) from public;
revoke all on function public.release_reservation_raw(uuid, uuid, jsonb) from public;

grant execute on function public.live_ingest_comment(uuid, text, text, text, jsonb, text, text, jsonb) to service_role;
grant execute on function public.live_session_for_ref(text, text) to service_role;
grant execute on function public.live_expire_claims(uuid, boolean) to service_role;

comment on table public.live_sessions is
  'One live broadcast. current_item_id is what a bare "mine" refers to.';
comment on table public.live_comments is
  'Every comment as received, deduplicated on the platform''s own id. Kept even when it is not a claim.';
comment on table public.live_claims is
  'A parsed claim holding stock, its deadline, and what became of it.';

-- ---------------------------------------------------------------------------
-- `ON DELETE SET NULL` on a composite FK nulls the whole key
-- ---------------------------------------------------------------------------
/**
 * Sixteen constraints, all broken the same way, found while testing this phase.
 *
 * The pattern in CLAUDE.md is right: a denormalised `tenant_id` needs a **composite**
 * foreign key `(tenant_id, parent_id)` against the parent's `unique (tenant_id, id)`,
 * because that makes a cross-tenant child unrepresentable rather than merely
 * forbidden — it holds even inside a `SECURITY DEFINER` function.
 *
 * What nobody noticed is that `on delete set null` applies to *every column in the
 * key*. Deleting a parent therefore tries to write `tenant_id = NULL` on the child,
 * and `tenant_id` is `not null` on every one of these tables. So the delete does not
 * cascade — it raises:
 *
 *   null value in column "tenant_id" of relation "order_items"
 *   violates not-null constraint
 *
 * Which means, before this migration:
 *
 *   - deleting a product that has ever been ordered fails
 *   - deleting a category that has products fails
 *   - deleting a customer who has ordered fails
 *   - deleting a location, a shipment or a cart with an order attached fails
 *
 * Every one of those is a button in the dashboard that answers "something went
 * wrong". It was invisible because the tenancy suite deletes *tenants*, where the
 * child rows cascade away for a different reason and the SET NULL never fires.
 *
 * Postgres 15 added `on delete set null (column_list)`, which nulls only the columns
 * named. CI runs 15.8 and local runs 17.6, so both are covered — but this is the
 * floor: on 14 there is no fix short of a trigger.
 */
alter table public.carts drop constraint carts_tenant_id_customer_id_fkey;
alter table public.carts add constraint carts_tenant_id_customer_id_fkey foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete set null (customer_id);
alter table public.categories drop constraint categories_tenant_id_parent_id_fkey;
alter table public.categories add constraint categories_tenant_id_parent_id_fkey foreign key (tenant_id, parent_id) references public.categories (tenant_id, id) on delete set null (parent_id);
alter table public.cod_remittance_lines drop constraint cod_remittance_lines_tenant_id_order_id_fkey;
alter table public.cod_remittance_lines add constraint cod_remittance_lines_tenant_id_order_id_fkey foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete set null (order_id);
alter table public.cod_remittance_lines drop constraint cod_remittance_lines_tenant_id_shipment_id_fkey;
alter table public.cod_remittance_lines add constraint cod_remittance_lines_tenant_id_shipment_id_fkey foreign key (tenant_id, shipment_id) references public.shipments (tenant_id, id) on delete set null (shipment_id);
alter table public.live_claims drop constraint live_claims_tenant_id_comment_id_fkey;
alter table public.live_claims add constraint live_claims_tenant_id_comment_id_fkey foreign key (tenant_id, comment_id) references public.live_comments (tenant_id, id) on delete set null (comment_id);
alter table public.live_claims drop constraint live_claims_tenant_id_order_id_fkey;
alter table public.live_claims add constraint live_claims_tenant_id_order_id_fkey foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete set null (order_id);
alter table public.live_sessions drop constraint live_sessions_current_item_fkey;
alter table public.live_sessions add constraint live_sessions_current_item_fkey foreign key (tenant_id, current_item_id) references public.live_items (tenant_id, id) on delete set null (current_item_id);
alter table public.live_sessions drop constraint live_sessions_tenant_id_location_id_fkey;
alter table public.live_sessions add constraint live_sessions_tenant_id_location_id_fkey foreign key (tenant_id, location_id) references public.locations (tenant_id, id) on delete set null (location_id);
alter table public.order_items drop constraint order_items_tenant_id_variant_id_fkey;
alter table public.order_items add constraint order_items_tenant_id_variant_id_fkey foreign key (tenant_id, variant_id) references public.product_variants (tenant_id, id) on delete set null (variant_id);
alter table public.order_rts drop constraint order_rts_tenant_id_location_id_fkey;
alter table public.order_rts add constraint order_rts_tenant_id_location_id_fkey foreign key (tenant_id, location_id) references public.locations (tenant_id, id) on delete set null (location_id);
alter table public.order_rts drop constraint order_rts_tenant_id_shipment_id_fkey;
alter table public.order_rts add constraint order_rts_tenant_id_shipment_id_fkey foreign key (tenant_id, shipment_id) references public.shipments (tenant_id, id) on delete set null (shipment_id);
alter table public.orders drop constraint orders_tenant_id_cart_id_fkey;
alter table public.orders add constraint orders_tenant_id_cart_id_fkey foreign key (tenant_id, cart_id) references public.carts (tenant_id, id) on delete set null (cart_id);
alter table public.orders drop constraint orders_tenant_id_customer_id_fkey;
alter table public.orders add constraint orders_tenant_id_customer_id_fkey foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete set null (customer_id);
alter table public.product_images drop constraint product_images_tenant_id_variant_id_fkey;
alter table public.product_images add constraint product_images_tenant_id_variant_id_fkey foreign key (tenant_id, variant_id) references public.product_variants (tenant_id, id) on delete set null (variant_id);
alter table public.products drop constraint products_tenant_id_category_id_fkey;
alter table public.products add constraint products_tenant_id_category_id_fkey foreign key (tenant_id, category_id) references public.categories (tenant_id, id) on delete set null (category_id);
alter table public.sms_logs drop constraint sms_logs_tenant_id_order_id_fkey;
alter table public.sms_logs add constraint sms_logs_tenant_id_order_id_fkey foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete set null (order_id);
