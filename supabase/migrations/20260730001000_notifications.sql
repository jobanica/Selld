-- ---------------------------------------------------------------------------
-- Phase 6 — outbound notification plumbing
-- ---------------------------------------------------------------------------
-- Hard rule 7: every external API call is wrapped in an idempotency key + retry
-- with exponential backoff, and logged to `integration_logs`. Order confirmation
-- SMS is the first outbound call the product actually makes, so the tables the
-- rule refers to land here.
--
-- The retry and idempotency-key machinery already exists in `src/core/integration`
-- from phase 0. What was missing was somewhere to write the record.

create table public.integration_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  provider        text not null,
  operation       text not null,
  -- The key the provider saw. Unique per tenant so a replayed send collapses
  -- rather than duplicating — the same property the concurrency work relies on for
  -- stock, applied to outbound calls.
  idempotency_key text not null,
  status          text not null check (status in ('pending', 'success', 'failed', 'skipped')),
  attempt         int not null default 1 check (attempt >= 1),
  http_status     int,
  duration_ms     int,
  error_code      text,
  error_message   text,
  request         jsonb,
  response        jsonb,
  created_at      timestamptz not null default now(),

  unique (tenant_id, idempotency_key)
);

create index integration_logs_tenant_idx on public.integration_logs (tenant_id, created_at desc);
create index integration_logs_op_idx     on public.integration_logs (tenant_id, provider, operation);

comment on table public.integration_logs is
  'One row per outbound provider call. `unique (tenant_id, idempotency_key)` is what makes a replay a no-op instead of a duplicate.';

create table public.sms_logs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  "to"          text not null check ("to" ~ '^\+63[0-9]{9,10}$'),
  body          text not null,
  provider      text not null,
  provider_ref  text,
  status        text not null check (status in ('queued','sent','delivered','failed','rejected')),
  -- What the provider charged us. SMS is resold, so cost is attributable per
  -- message or the margin cannot be reported.
  cost_centavos public.centavos not null default 0 check (cost_centavos >= 0),
  segments      int not null default 1 check (segments >= 1),
  purpose       text not null check (purpose in ('tracking','otp','broadcast','abandoned_cart','test')),
  order_id      uuid,
  created_at    timestamptz not null default now(),

  foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete set null
);

create index sms_logs_tenant_idx on public.sms_logs (tenant_id, created_at desc);
create index sms_logs_order_idx  on public.sms_logs (order_id);

comment on table public.sms_logs is
  'Every SMS sent, with cost and purpose. Phase 11 adds the credit ledger that reads this.';

-- ---------------------------------------------------------------------------
-- Recording a notification, authorised by the cart token
-- ---------------------------------------------------------------------------
-- The storefront server holds the anon key by design (least privilege — it only
-- ever needs what a buyer needs). So it cannot INSERT into these tables directly,
-- and it should not: a function authorised by the same cart token that produced
-- the order is a narrower grant than handing the server a service-role key.
--
-- Idempotent by construction: the unique key on (tenant_id, idempotency_key) means
-- a retried send records once. `on conflict do nothing` plus a row count tells the
-- caller whether it was the one that claimed the send.
create or replace function public.record_order_sms(
  p_token           text,
  p_body            text,
  p_provider        text,
  p_provider_ref    text,
  p_status          text,
  p_cost_centavos   bigint default 0,
  p_segments        int default 1,
  p_idempotency_key text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   record;
  v_key     text;
  v_claimed int;
begin
  select o.id, o.tenant_id, o.contact_phone
  into v_order
  from public.orders o
    join public.carts c on c.id = o.cart_id
  where c.token = p_token
  limit 1;

  if v_order.id is null then
    return false;
  end if;

  v_key := coalesce(nullif(btrim(p_idempotency_key), ''),
                    v_order.tenant_id || '|sms.order_confirmed|' || v_order.id || '|0');

  insert into public.integration_logs
    (tenant_id, provider, operation, idempotency_key, status, request)
  values (v_order.tenant_id, p_provider, 'sms.order_confirmed', v_key,
          case when p_status in ('sent','delivered','queued') then 'success' else 'failed' end,
          jsonb_build_object('to', v_order.contact_phone, 'segments', p_segments))
  on conflict (tenant_id, idempotency_key) do nothing;

  get diagnostics v_claimed = row_count;
  -- Already recorded: a duplicate send attempt. Say so and write nothing more, so
  -- the SMS log does not gain a second row for one message.
  if v_claimed = 0 then
    return false;
  end if;

  insert into public.sms_logs
    (tenant_id, "to", body, provider, provider_ref, status, cost_centavos, segments, purpose, order_id)
  values (v_order.tenant_id, v_order.contact_phone, p_body, p_provider,
          nullif(btrim(coalesce(p_provider_ref, '')), ''), p_status,
          greatest(coalesce(p_cost_centavos, 0), 0), greatest(coalesce(p_segments, 1), 1),
          'tracking', v_order.id);

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.integration_logs enable row level security;
alter table public.sms_logs         enable row level security;
alter table public.integration_logs force  row level security;
alter table public.sms_logs         force  row level security;

-- Read-only for sellers. These are an audit trail; nothing in the dashboard has
-- any business editing what a provider was told.
create policy "Members read integration logs" on public.integration_logs for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read sms logs" on public.sms_logs for select to authenticated
  using (public.is_tenant_member(tenant_id));

grant select on public.integration_logs to authenticated;
grant select on public.sms_logs         to authenticated;

-- anon writes neither table; it can only call the function, which authorises with
-- the cart token and decides what gets written.
grant execute on function public.record_order_sms(text, text, text, text, text, bigint, int, text)
  to anon, authenticated;
