/**
 * Phase 9 — Order management.
 *
 * The done-when is a stopwatch: 50 orders from `confirmed` to `packed` in under 60
 * seconds. That number is not about rendering — it is about how many round trips a
 * seller's thumb has to pay for, so the shape of this file follows from it.
 *
 * ## One statement moves a batch, not fifty
 *
 * `orders_bulk_transition` takes an array of ids and does the whole batch in two
 * set-based statements: one `UPDATE ... WHERE id = any(...)` and one
 * `INSERT INTO order_status_history ... SELECT`. Fifty single-row RPCs would be
 * fifty network round trips, which at a provincial 150ms RTT is 7.5 seconds of
 * latency before any work happens — and worse, fifty separate transactions, so a
 * connection drop halfway leaves a seller with no idea which half moved.
 *
 * ## The timeline is written by the same statement that moves the row
 *
 * `order_status_history` is not a nice-to-have log; phase 12's COD reconciliation
 * and phase 18's fulfilment analytics both read it. Writing it in the same
 * statement as the update means it cannot drift — there is no path that changes a
 * status without recording it, because there is no second statement to forget.
 *
 * ## "Today's COD" is a Manila day
 *
 * Hard rule 3. `now() at time zone 'Asia/Manila'` is the whole of it, and getting it
 * wrong splits one Manila morning across two buckets — a seller doing a COD cutoff
 * at 8am sees yesterday's orders and misses two hours of today's.
 */

-- ---------------------------------------------------------------------------
-- Internal notes
-- ---------------------------------------------------------------------------
/**
 * Staff notes on an order.
 *
 * Deliberately *not* `orders.notes`, which is the buyer's own message from
 * checkout ("please leave with the guard"). Merging them would put a seller's
 * "customer argues about every RTS, require prepayment" in a column that a future
 * receipt or courier manifest might legitimately print.
 *
 * Append-only from the UI's perspective: notes are a record of what happened, and a
 * timeline you can rewrite is not evidence. There is no UPDATE policy.
 */
create table public.order_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  order_id   uuid not null,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete cascade
);

create index order_notes_order_idx on public.order_notes (tenant_id, order_id, created_at desc);

alter table public.order_notes enable row level security;
alter table public.order_notes force  row level security;

create policy "Members read order notes" on public.order_notes for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write order notes" on public.order_notes for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff') and author_id = auth.uid());
-- No UPDATE policy at all. See the note above.
create policy "Admins delete order notes" on public.order_notes for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'admin'));

grant select, insert, delete on public.order_notes to authenticated;

-- ---------------------------------------------------------------------------
-- The status pipeline
-- ---------------------------------------------------------------------------
/**
 * Which fulfilment transitions are legal.
 *
 * A table rather than a CHECK or a CASE, because the set is read by the UI to
 * decide which bulk actions to offer. Two copies of this rule — one in SQL and one
 * in TypeScript — is how a screen ends up offering a button the server refuses.
 *
 * `cancelled` is reachable from anything not yet shipped: once a parcel is with a
 * courier, the terminal states are `delivered` or `rts`, and pretending otherwise
 * loses the parcel from every report.
 */
create table public.order_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into public.order_transitions (from_status, to_status) values
  ('pending',   'confirmed'),
  ('pending',   'cancelled'),
  ('confirmed', 'packed'),
  ('confirmed', 'cancelled'),
  ('packed',    'shipped'),
  ('packed',    'confirmed'),   -- unpack: picked the wrong item
  ('packed',    'cancelled'),
  ('shipped',   'delivered'),
  ('shipped',   'rts'),
  ('rts',       'confirmed');   -- re-dispatch after a failed delivery

alter table public.order_transitions enable row level security;
create policy "Anyone signed in reads the pipeline" on public.order_transitions
  for select to authenticated using (true);
grant select on public.order_transitions to authenticated;

-- ---------------------------------------------------------------------------
-- Bulk transition — the done-when
-- ---------------------------------------------------------------------------
/**
 * Move a batch of orders to one fulfilment status.
 *
 * Two set-based statements for the whole batch. Returns a jsonb summary rather than
 * raising on the first bad row: in a batch of fifty, one order that someone else
 * already packed must not throw away the other forty-nine. The seller is told what
 * moved and what did not.
 *
 * Skips rather than fails when:
 *   - the order is already at the target status (a double-tap, or two packers)
 *   - the transition is not in `order_transitions`
 *   - the order belongs to another tenant, or does not exist
 *
 * Authorisation is checked once against the tenant rather than per row — and the
 * `where tenant_id = p_tenant_id` on the update is what makes that safe: ids from
 * another tenant simply do not match.
 *
 * **The level depends on what the transition means, not on the fact that it is a
 * write.** Moving a parcel along — confirm, pack, ship, delivered, RTS — is
 * `packer`, because that is the entire job of the role that is literally called
 * packer, and this is the screen the role exists for. Requiring `staff` here (as
 * this did first, until the tenancy suite pointed out that `packer` ranks *below*
 * `staff`) would lock a packer out of packing.
 *
 * Cancelling is `staff`: it is a commercial decision with a refund attached, not a
 * warehouse one.
 */
create or replace function public.orders_bulk_transition(
  p_tenant_id uuid,
  p_order_ids uuid[],
  p_to_status text,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_moved   uuid[];
  v_count   int;
  v_skipped int;
begin
  if not public.has_tenant_role(
       p_tenant_id,
       case when p_to_status = 'cancelled' then 'staff'::public.tenant_role
            else 'packer'::public.tenant_role end) then
    raise exception 'Not allowed to change orders for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    return jsonb_build_object('moved', 0, 'skipped', 0, 'orderIds', '[]'::jsonb);
  end if;

  -- A cap, so a crafted request cannot ask for a million-row update. Well above any
  -- real batch: the done-when is fifty.
  if array_length(p_order_ids, 1) > 500 then
    raise exception 'Too many orders in one batch (max 500)'
      using errcode = 'program_limit_exceeded';
  end if;

  if not exists (select 1 from public.order_transitions where to_status = p_to_status) then
    raise exception 'Unknown fulfilment status %', p_to_status
      using errcode = 'check_violation';
  end if;

  -- Statement one: move everything that legally can move.
  with moved as (
    update public.orders o
       set fulfillment_status = p_to_status
     where o.tenant_id = p_tenant_id
       and o.id = any(p_order_ids)
       and exists (
         select 1 from public.order_transitions t
         where t.from_status = o.fulfillment_status and t.to_status = p_to_status
       )
    returning o.id, o.fulfillment_status
  )
  select array_agg(id) into v_moved from moved;

  v_count := coalesce(array_length(v_moved, 1), 0);
  v_skipped := array_length(p_order_ids, 1) - v_count;

  -- Statement two: the timeline, for exactly the rows that moved.
  --
  -- `from_status` is not recoverable from the UPDATE's RETURNING (it returns the new
  -- value), so it is read back from the most recent history row. An order always has
  -- one: checkout_place_order writes the opening entry.
  if v_count > 0 then
    insert into public.order_status_history
      (tenant_id, order_id, field, from_status, to_status, actor_id, note)
    select
      p_tenant_id,
      o.id,
      'fulfillment_status',
      (select h.to_status from public.order_status_history h
        where h.order_id = o.id and h.field = 'fulfillment_status'
        order by h.created_at desc limit 1),
      p_to_status,
      auth.uid(),
      p_note
    from public.orders o
    where o.id = any(v_moved);
  end if;

  return jsonb_build_object(
    'moved',    v_count,
    'skipped',  v_skipped,
    'orderIds', to_jsonb(coalesce(v_moved, array[]::uuid[]))
  );
end;
$$;

comment on function public.orders_bulk_transition(uuid, uuid[], text, text) is
  'Move a batch of orders to one fulfilment status in two set-based statements. Skips illegal transitions rather than failing the batch.';

/**
 * A Philippine phone reduced to its national digits, for search.
 *
 * `+639171234567`, `639171234567`, `09171234567` and `9171234567` all become
 * `9171234567`, so a seller finds the order whichever way they write it — and they
 * write it every way. Returns null for anything too short to be a useful phone
 * fragment, which is what keeps a four-digit order number from being matched
 * against other buyers' numbers.
 *
 * IMMUTABLE so it can be used in an index if the order table ever needs one; the
 * substring search below cannot use an index either way, and at a few thousand
 * orders per tenant that is the right trade against a second stored column that can
 * drift from `contact_phone`.
 */
create or replace function public.ph_national_digits(p_input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(coalesce(p_input, ''), '[^0-9]', '', 'g'),
      '^(63|0)', ''),
    '')
$$;

-- ---------------------------------------------------------------------------
-- The order list
-- ---------------------------------------------------------------------------
/**
 * One page of orders, as one jsonb document.
 *
 * Saved views are named rather than expressed as filter parameters, because the
 * names are the seller's actual workflow — "to pack" is a question they ask twenty
 * times a day, and making them reconstruct it from three dropdowns each time is how
 * a dashboard becomes something they avoid.
 *
 *   needs_confirmation  pending
 *   to_pack             confirmed
 *   to_ship             packed
 *   in_transit          shipped
 *   rts                 rts
 *   today_cod           COD, placed today in **Manila**, not yet delivered
 *   all                 everything
 *
 * Search covers phone, name, order number and waybill in one box. A seller looking
 * at a Messenger thread has one of those and does not know or care which field it
 * lives in.
 *
 * Keyset pagination on `(placed_at, id)` rather than OFFSET: an order list is
 * append-heavy at the top, and OFFSET pagination silently repeats or skips rows as
 * new orders arrive mid-scroll.
 */
create or replace function public.orders_list(
  p_tenant_id uuid,
  p_view      text default 'all',
  p_search    text default null,
  p_limit     int default 50,
  p_before_placed_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit  int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  /**
   * The search string reduced to a *national* phone fragment.
   *
   * Phones are stored `+639171234567`, so digits alone are `639171234567`. A seller
   * types `09171234567` — the way it is written on every receipt and in every
   * Messenger thread in the country — whose digits are `09171234567`, and that is
   * **not** a substring of the stored form. Searching for the one number a seller
   * actually has returned nothing.
   *
   * `ph_national_digits` strips a leading `63` or `0` from both sides so they meet
   * in the middle at `9171234567`.
   *
   * The 7-digit floor matters too: at 4 it also matched order numbers against phone
   * digits, so searching order `0001` returned eleven rows because `00010`…`00019`
   * are inside other buyers' numbers. Seven digits is short enough for "the last
   * seven" and long enough not to be an order number.
   */
  v_phone  text := (select case when length(d) >= 7 then d end
                    from public.ph_national_digits(p_search) as d);
  v_rows   jsonb;
begin
  if not public.is_tenant_member(p_tenant_id) then
    return null;
  end if;

  select coalesce(jsonb_agg(row order by rn), '[]'::jsonb) into v_rows
  from (
    select
      row_number() over (order by o.placed_at desc, o.id desc) as rn,
      jsonb_build_object(
        'id',                o.id,
        'orderNumber',      o.order_number,
        'placedAt',         o.placed_at,
        'contactName',      o.contact_name,
        'contactPhone',     o.contact_phone,
        'city',             o.shipping_address ->> 'cityName',
        'province',         o.shipping_address ->> 'provinceName',
        'paymentMethod',    o.payment_method,
        'paymentStatus',    o.payment_status,
        'fulfillmentStatus', o.fulfillment_status,
        'grandTotal',       o.grand_total_centavos,
        'itemCount',        (select coalesce(sum(oi.qty), 0) from public.order_items oi
                              where oi.order_id = o.id),
        'source',           o.source
      ) as row
    from public.orders o
    where o.tenant_id = p_tenant_id
      and case p_view
        when 'needs_confirmation' then o.fulfillment_status = 'pending'
        when 'to_pack'            then o.fulfillment_status = 'confirmed'
        when 'to_ship'            then o.fulfillment_status = 'packed'
        when 'in_transit'         then o.fulfillment_status = 'shipped'
        when 'rts'                then o.fulfillment_status = 'rts'
        -- Manila day, not UTC. See the header.
        when 'today_cod'          then o.payment_method = 'cod'
                                   and o.fulfillment_status not in ('delivered', 'cancelled')
                                   and (o.placed_at at time zone 'Asia/Manila')::date
                                     = (now() at time zone 'Asia/Manila')::date
        else true
      end
      and (
        v_search is null
        or o.order_number ilike '%' || v_search || '%'
        or o.contact_name ilike '%' || v_search || '%'
        -- Both sides reduced to the national number, so every way a seller writes
        -- a PH mobile finds the same order. See `v_phone` above.
        or (v_phone is not null
            and public.ph_national_digits(o.contact_phone) like '%' || v_phone || '%')
      )
      -- Keyset: strictly older than the cursor.
      and (p_before_placed_at is null
           or (o.placed_at, o.id) < (p_before_placed_at, coalesce(p_before_id, o.id)))
    order by o.placed_at desc, o.id desc
    limit v_limit
  ) page;

  return jsonb_build_object(
    'view',    coalesce(p_view, 'all'),
    'orders',  v_rows,
    'counts',  public.orders_view_counts(p_tenant_id)
  );
end;
$$;

/**
 * How many orders sit in each saved view.
 *
 * One pass over the tenant's open orders rather than seven counting queries — the
 * tab bar shows all of them at once, so seven round trips would be seven times the
 * latency for one row of numbers.
 */
create or replace function public.orders_view_counts(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'needs_confirmation', count(*) filter (where fulfillment_status = 'pending'),
    'to_pack',            count(*) filter (where fulfillment_status = 'confirmed'),
    'to_ship',            count(*) filter (where fulfillment_status = 'packed'),
    'in_transit',         count(*) filter (where fulfillment_status = 'shipped'),
    'rts',                count(*) filter (where fulfillment_status = 'rts'),
    'today_cod',          count(*) filter (
                            where payment_method = 'cod'
                              and fulfillment_status not in ('delivered', 'cancelled')
                              and (placed_at at time zone 'Asia/Manila')::date
                                = (now() at time zone 'Asia/Manila')::date),
    'all',                count(*)
  )
  from public.orders
  where tenant_id = p_tenant_id and public.is_tenant_member(p_tenant_id);
$$;

-- ---------------------------------------------------------------------------
-- Order detail
-- ---------------------------------------------------------------------------
/**
 * Everything one order screen shows, in one round trip.
 *
 * Same discipline as the storefront's `storefront_product_page`: a detail view that
 * fans out into six queries costs a seller on provincial mobile data six sequential
 * latencies to see one order.
 *
 * Includes the phase-8 payment rows and the phase-12 timeline, because this is the
 * screen where a seller answers "did this person pay?" — the question the whole
 * payments phase exists to make answerable.
 */
create or replace function public.order_detail(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null or not public.is_tenant_member(v_order.tenant_id) then
    return null;
  end if;

  return jsonb_build_object(
    'id',                v_order.id,
    'orderNumber',       v_order.order_number,
    'placedAt',          v_order.placed_at,
    'source',            v_order.source,
    'contactName',       v_order.contact_name,
    'contactPhone',      v_order.contact_phone,
    'contactEmail',      v_order.contact_email,
    'address',           v_order.shipping_address,
    'buyerNote',         v_order.notes,
    'paymentMethod',     v_order.payment_method,
    'paymentStatus',     v_order.payment_status,
    'fulfillmentStatus', v_order.fulfillment_status,
    'cancelledReason',   v_order.cancelled_reason,
    'subtotal',          v_order.subtotal_centavos,
    'discountTotal',     v_order.discount_total_centavos,
    'shippingTotal',     v_order.shipping_total_centavos,
    'codFee',            v_order.cod_fee_centavos,
    'grandTotal',        v_order.grand_total_centavos,

    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',           oi.id,
        'productName',  oi.product_name,
        'variantLabel', oi.variant_label,
        'sku',          oi.sku,
        'qty',          oi.qty,
        'unitPrice',    oi.unit_price_centavos,
        'lineTotal',    oi.line_total_centavos
      ) order by oi.created_at, oi.id), '[]'::jsonb)
      from public.order_items oi where oi.order_id = p_order_id),

    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',          p.id,
        'provider',    p.provider,
        'method',      p.method,
        'status',      p.status,
        'amount',      p.amount_centavos,
        'fee',         p.fee_centavos,
        'refunded',    p.refunded_centavos,
        'providerRef', p.provider_ref,
        'proofPath',   p.proof_path,
        'proofNote',   p.proof_note,
        'paidAt',      p.paid_at,
        'createdAt',   p.created_at
      ) order by p.created_at), '[]'::jsonb)
      from public.payments p where p.order_id = p_order_id),

    'timeline', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',         h.id,
        'field',      h.field,
        'fromStatus', h.from_status,
        'toStatus',   h.to_status,
        'note',       h.note,
        'actorName',  pr.full_name,
        'createdAt',  h.created_at
      ) order by h.created_at desc, h.id), '[]'::jsonb)
      from public.order_status_history h
        left join public.profiles pr on pr.id = h.actor_id
      where h.order_id = p_order_id),

    'notes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',         n.id,
        'body',       n.body,
        'authorName', pr.full_name,
        'createdAt',  n.created_at
      ) order by n.created_at desc), '[]'::jsonb)
      from public.order_notes n
        left join public.profiles pr on pr.id = n.author_id
      where n.order_id = p_order_id),

    -- Phase 10 fills this in. Present and empty so the screen has a shape to grow
    -- into rather than a layout that shifts when couriers land.
    'shipments', '[]'::jsonb,

    'allowedTransitions', (
      select coalesce(jsonb_agg(t.to_status order by t.to_status), '[]'::jsonb)
      from public.order_transitions t where t.from_status = v_order.fulfillment_status)
  );
end;
$$;

/**
 * The packing data for a batch, in one round trip.
 *
 * Feeds both the packing slips (one per order) and the aggregated picking list (one
 * row per SKU across the whole batch). A seller printing forty slips must not pay
 * forty round trips, and the picking list is the thing that actually saves time:
 * walk the shelves once with totals rather than once per order.
 */
create or replace function public.orders_packing_batch(
  p_tenant_id uuid,
  p_order_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    return null;
  end if;

  return jsonb_build_object(
    'store', (
      select jsonb_build_object('name', t.name, 'slug', t.slug)
      from public.tenants t where t.id = p_tenant_id),

    'orders', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',           o.id,
        'orderNumber',  o.order_number,
        'placedAt',     o.placed_at,
        'contactName',  o.contact_name,
        'contactPhone', o.contact_phone,
        'address',      o.shipping_address,
        'buyerNote',    o.notes,
        'paymentMethod', o.payment_method,
        'paymentStatus', o.payment_status,
        'grandTotal',   o.grand_total_centavos,
        'codDue',       case when o.payment_method = 'cod' and o.payment_status <> 'paid'
                             then o.grand_total_centavos else 0 end,
        'items', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'productName',  oi.product_name,
            'variantLabel', oi.variant_label,
            'sku',          oi.sku,
            'qty',          oi.qty
          ) order by oi.product_name, oi.variant_label), '[]'::jsonb)
          from public.order_items oi where oi.order_id = o.id)
      ) order by o.order_number), '[]'::jsonb)
      from public.orders o
      where o.tenant_id = p_tenant_id and o.id = any(p_order_ids)),

    -- One row per SKU across the batch: walk the shelves once.
    'pickingList', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'productName',  x.product_name,
        'variantLabel', x.variant_label,
        'sku',          x.sku,
        'qty',          x.qty
      ) order by x.product_name, x.variant_label), '[]'::jsonb)
      from (
        select oi.product_name, oi.variant_label, oi.sku, sum(oi.qty) as qty
        from public.order_items oi
          join public.orders o on o.id = oi.order_id
        where o.tenant_id = p_tenant_id and o.id = any(p_order_ids)
        group by oi.product_name, oi.variant_label, oi.sku
      ) x)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
/**
 * Add an internal note.
 *
 * A function rather than a bare insert so `author_id` is taken from the session
 * instead of the request body — a note whose author the client can choose is not a
 * record of anything.
 */
create or replace function public.add_order_note(p_order_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_id    uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'no_data_found';
  end if;
  if not public.has_tenant_role(v_order.tenant_id, 'staff') then
    raise exception 'Not allowed to add notes to this order'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.order_notes (tenant_id, order_id, author_id, body)
  values (v_order.tenant_id, p_order_id, auth.uid(), btrim(p_body))
  returning id into v_id;

  return jsonb_build_object('id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Manual orders
-- ---------------------------------------------------------------------------
/**
 * An order taken in a DM, typed in by the seller.
 *
 * The reason this exists: most PH social sellers still close a large share of sales
 * in Messenger, and an order that only lives in a chat thread is invisible to
 * inventory, to shipping and to every report. Typing it in is what makes the rest of
 * the system true.
 *
 * **Priced by `cart_pricing`, not by hand.** It builds a real cart, prices it
 * through the same function the storefront uses, and calls the same
 * `checkout_place_order`. A second pricing path would be a second place for the
 * shipping resolver, the COD fee and hard rule 6 to disagree — and the one that
 * disagrees silently is the one a seller types into at 11pm.
 */
create or replace function public.create_manual_order(
  p_tenant_id     uuid,
  p_contact_name  text,
  p_contact_phone text,
  p_address       jsonb,
  p_items         jsonb,
  p_payment_method text default 'cod',
  p_notes         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token   text;
  v_slug    text;
  v_item    jsonb;
  v_receipt jsonb;
begin
  if not public.has_tenant_role(p_tenant_id, 'staff') then
    raise exception 'Not allowed to create orders for this tenant'
      using errcode = 'insufficient_privilege';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A manual order needs at least one item'
      using errcode = 'check_violation', hint = 'empty_cart';
  end if;

  select slug into v_slug from public.tenants where id = p_tenant_id;

  -- A real cart, so pricing, stock reservation and the COD rules all apply exactly
  -- as they do for a buyer.
  v_token := public.cart_create(v_slug, null);

  for v_item in select * from jsonb_array_elements(p_items) loop
    perform public.cart_add_item(
      v_token,
      (v_item ->> 'variantId')::uuid,
      coalesce((v_item ->> 'qty')::int, 1));
  end loop;

  v_receipt := public.checkout_place_order(
    v_token,
    p_contact_name,
    p_contact_phone,
    p_address,
    p_payment_method,
    null,
    p_notes);

  -- `source` is what tells "50 orders today" apart from "50 storefront orders
  -- today", and phase 18's channel analytics is built on it.
  update public.orders
     set source = 'manual'
   where id = (v_receipt ->> 'id')::uuid;

  return v_receipt;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
/**
 * A buyer has no business here.
 *
 * `from public`, not `from anon` — Postgres grants EXECUTE to PUBLIC by default and
 * revoking from a named role does not remove a privilege held through PUBLIC. That
 * trap shipped `record_payment_event` callable by anon in phase 8; the CI step added
 * then covers money-moving functions, and these are the order-moving ones.
 */
revoke all on function public.orders_list(uuid, text, text, int, timestamptz, uuid) from public;
revoke all on function public.orders_view_counts(uuid)                              from public;
revoke all on function public.order_detail(uuid)                                    from public;
revoke all on function public.orders_bulk_transition(uuid, uuid[], text, text)      from public;
revoke all on function public.orders_packing_batch(uuid, uuid[])                    from public;
revoke all on function public.add_order_note(uuid, text)                            from public;
revoke all on function public.create_manual_order(uuid, text, text, jsonb, jsonb, text, text) from public;

grant execute on function public.orders_list(uuid, text, text, int, timestamptz, uuid) to authenticated;
grant execute on function public.orders_view_counts(uuid)                              to authenticated;
grant execute on function public.order_detail(uuid)                                    to authenticated;
grant execute on function public.orders_bulk_transition(uuid, uuid[], text, text)      to authenticated;
grant execute on function public.orders_packing_batch(uuid, uuid[])                    to authenticated;
grant execute on function public.add_order_note(uuid, text)                            to authenticated;
grant execute on function public.create_manual_order(uuid, text, text, jsonb, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Indexes for the views
-- ---------------------------------------------------------------------------
-- The saved views all filter on (tenant_id, fulfillment_status) and order by
-- placed_at desc. The phase-6 index is (tenant_id, fulfillment_status) with no sort
-- column, so every view still sorts. This covers the whole access pattern.
create index orders_view_idx
  on public.orders (tenant_id, fulfillment_status, placed_at desc, id desc);

-- Search by name. Phone already has `orders_phone_idx`; order number has a unique.
create index orders_contact_name_trgm_idx
  on public.orders using gin (contact_name extensions.gin_trgm_ops);
