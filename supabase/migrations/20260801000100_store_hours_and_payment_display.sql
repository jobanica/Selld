-- ---------------------------------------------------------------------------
-- Store hours, and payment methods a buyer can actually see
-- ---------------------------------------------------------------------------
-- Two things a seller asked for and one bug found on the way to them.
--
-- 1. `store.hours` — when the seller is at their phone. A storefront never
--    literally closes, so these are *order* hours, and they answer the single
--    most common question in a social seller's inbox: "open pa po kayo?".
--
-- 2. Payment methods, on the store rather than only at the last step of
--    checkout. A buyer deciding whether to fill in an address wants to know
--    first whether they can pay cash on delivery.
--
-- 3. The bug: `payments.online_enabled` has been seeded, written by the
--    onboarding wizard, and typed in the client since phase 8 — and read by
--    nothing. `storefront_payment_methods()` offered every method the seller's
--    Xendit account could take regardless of it, so the switch was decoration.
--    It bites only once a store has a live account, which is why twenty phases
--    did not notice. Below, one function decides, and both the storefront's
--    "we accept" strip and checkout's buttons read that one answer — because two
--    places computing the same rule is how they end up disagreeing about which
--    buttons a buyer gets.
--
-- Nothing here is a new trust boundary. `store.hours` is public information the
-- seller is publishing on purpose, and the payment answer is the same whitelist
-- `storefront_payment_methods()` already returned to anon.

-- ---------------------------------------------------------------------------
-- HH:MM, without an exception
-- ---------------------------------------------------------------------------
/**
 * Minutes since Manila midnight, or null for anything that is not `HH:MM`.
 *
 * Null rather than an error on purpose. `tenant_settings` is key/value, so the
 * client's parser is the only thing keeping a malformed time out of the row —
 * and this function sits in the storefront's critical path, where a raised
 * `invalid input syntax for type integer` is not a validation message, it is a
 * store that will not render.
 */
create or replace function public.hhmm_minutes(p_value text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      then substr(p_value, 1, 2)::int * 60 + substr(p_value, 4, 2)::int
  end;
$$;

comment on function public.hhmm_minutes(text) is
  'Minutes past midnight for an HH:MM string; null for anything else.';

-- ---------------------------------------------------------------------------
-- What a store publishes about itself
-- ---------------------------------------------------------------------------
/**
 * Opening hours and accepted payment methods, for one store.
 *
 * `security definer` because `tenant_settings` and `payment_accounts` are not
 * readable by anon and must not become so — this returns three booleans, a
 * whitelisted method list and a week the seller chose to publish, and nothing
 * else from either table.
 *
 * **`openNow` is decided here, in SQL, and never in the browser.** The storefront
 * is server-rendered and its hydration is deferred to idle-after-load, so a
 * status the client recomputed would differ from the server's whenever a minute
 * ticked in between — and on this surface a hydration mismatch discards the whole
 * server-rendered tree. Shipping the answer inside the payload makes the two
 * agree by construction, which is the same rule `cartCount` had to learn.
 */
create or replace function public.storefront_store_policies(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw      jsonb;
  v_days     jsonb;
  v_hours    jsonb := null;
  v_entry    jsonb;
  v_cod      boolean;
  v_online   boolean;
  v_methods  jsonb := '[]'::jsonb;
  v_now      timestamp;
  v_minutes  int;
  v_index    int;
  v_open     boolean := false;
  v_from     int;
  v_to       int;
begin
  -- Anon holds EXECUTE on this — `storefront_store_json` is invoker-rights, so
  -- it has to — which means the uuid is attacker-suppliable and the function
  -- must not answer for a store that is not publicly trading. `storefront_tenants`
  -- is the same active-only projection every other storefront_* function reads,
  -- and gating on it makes this function's reach exactly the storefront's.
  if p_tenant_id is null
     or not exists (select 1 from public.storefront_tenants t where t.id = p_tenant_id)
  then
    return jsonb_build_object(
      'hours', null,
      'payments', jsonb_build_object('cod', false, 'online', false, 'methods', '[]'::jsonb));
  end if;

  -- Hours ------------------------------------------------------------------
  select s.value into v_raw
  from public.tenant_settings s
  where s.tenant_id = p_tenant_id and s.key = 'store.hours';

  -- Publishing is opt-in, and the shape is checked before it is trusted. A store
  -- that never set hours shows none: a default week nobody chose would tell a
  -- buyer the shop is closed in the one moment they were ready to pay.
  if v_raw is not null
     and jsonb_typeof(v_raw) = 'object'
     and v_raw -> 'enabled' = 'true'::jsonb
     and jsonb_typeof(v_raw -> 'days') = 'array'
     and jsonb_array_length(v_raw -> 'days') = 7
  then
    v_days    := v_raw -> 'days';
    v_now     := (now() at time zone 'Asia/Manila');
    v_minutes := extract(hour from v_now)::int * 60 + extract(minute from v_now)::int;
    -- isodow is 1..7 with Monday = 1; the stored week is Monday-first.
    v_index   := extract(isodow from v_now)::int - 1;

    -- Today's window.
    v_entry := v_days -> v_index;
    if jsonb_typeof(v_entry) = 'object' then
      v_from := public.hhmm_minutes(v_entry ->> 'open');
      v_to   := public.hhmm_minutes(v_entry ->> 'close');
      if v_from is not null and v_to is not null then
        v_open := case
          when v_to > v_from then v_minutes >= v_from and v_minutes < v_to
          -- Closing at or before opening means the window runs past midnight —
          -- a live-selling night that ends at 2am. Today it covers everything
          -- from `open` to the end of the day.
          else v_minutes >= v_from
        end;
      end if;
    end if;

    -- Yesterday's window, where it spilled over into this morning. Without this
    -- a store open 8pm-2am reads as closed at 1am, which is the hour it was
    -- selling hardest.
    if not v_open then
      v_entry := v_days -> ((v_index + 6) % 7);
      if jsonb_typeof(v_entry) = 'object' then
        v_from := public.hhmm_minutes(v_entry ->> 'open');
        v_to   := public.hhmm_minutes(v_entry ->> 'close');
        v_open := v_from is not null and v_to is not null
                  and v_to <= v_from and v_minutes < v_to;
      end if;
    end if;

    v_hours := jsonb_build_object(
      'days',    v_days,
      'note',    coalesce(v_raw ->> 'note', ''),
      'openNow', v_open);
  end if;

  -- Payments ---------------------------------------------------------------
  -- COD defaults to on: it is how the overwhelming majority of PH social
  -- commerce is paid for, and a store with no row has not opted out of it.
  select coalesce(
    (select s.value = 'true'::jsonb
     from public.tenant_settings s
     where s.tenant_id = p_tenant_id and s.key = 'payments.cod_enabled'),
    true)
  into v_cod;

  -- Online defaults to off, and needs both halves: the seller's switch *and* an
  -- account that can actually take the money. Either one alone offers a buyer a
  -- button that fails.
  select coalesce(
    (select s.value = 'true'::jsonb
     from public.tenant_settings s
     where s.tenant_id = p_tenant_id and s.key = 'payments.online_enabled'),
    false)
  into v_online;

  v_online := v_online and exists (
    select 1 from public.payment_accounts a
    where a.tenant_id = p_tenant_id and a.provider = 'xendit' and a.is_enabled);

  if v_online then
    -- The `jsonb_typeof` guard is in the inner select rather than the outer
    -- where clause: `jsonb_array_elements_text` on a non-array raises, and a
    -- lateral cannot be relied on to run after a filter it is not inside of.
    select coalesce((
      select jsonb_agg(m.value order by m.ordinality)
      from (
        select s.value as chosen
        from public.tenant_settings s
        where s.tenant_id = p_tenant_id
          and s.key = 'payments.methods'
          and jsonb_typeof(s.value) = 'array'
      ) src
      cross join lateral jsonb_array_elements_text(src.chosen) with ordinality as m(value, ordinality)
      where m.value in ('gcash', 'maya', 'grabpay', 'qrph', 'card')
    ), '[]'::jsonb)
    into v_methods;
  end if;

  return jsonb_build_object(
    'hours', v_hours,
    'payments', jsonb_build_object('cod', v_cod, 'online', v_online, 'methods', v_methods));
end;
$$;

comment on function public.storefront_store_policies(uuid) is
  'Published opening hours (with openNow decided server-side) and the payment methods a store can actually take.';

-- ---------------------------------------------------------------------------
-- Both surfaces read the one answer
-- ---------------------------------------------------------------------------
-- Store identity + branding, now carrying what the store publishes about how it
-- trades. Merged with `||` so the storefront's `store` object grows two keys
-- rather than gaining a nested one the client would have to reach through.
create or replace function public.storefront_store_json(p_tenant_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',           s.id,
    'name',         s.name,
    'slug',         s.slug,
    'customDomain', s.custom_domain,
    'logoPath',     s.logo_path,
    'brandColor',   s.brand_color,
    'locale',       s.locale,
    'theme', coalesce(
      (select jsonb_build_object(
                'preset',    th.preset,
                'colors',    th.colors,
                'fonts',     th.fonts,
                'hero',      th.hero,
                'customCss', th.custom_css)
       from public.storefront_theme_public th
       where th.tenant_id = s.id),
      '{}'::jsonb)
  ) || public.storefront_store_policies(s.id)
  from public.storefront_tenants s
  where s.id = p_tenant_id;
$$;

/**
 * Which online methods a storefront can take right now.
 *
 * Now a thin projection of `storefront_store_policies`, which is the point: the
 * strip on the home page saying "GCash · Maya accepted" and the buttons on the
 * checkout page are the same list, from the same function. They used to be two
 * queries applying two slightly different rules, and the seller's
 * `payments.online_enabled` switch was honoured by neither.
 *
 * Still returns an empty array — never an error — for a store with no account,
 * so checkout renders COD alone rather than an error state.
 */
create or replace function public.storefront_payment_methods(
  p_slug   text default null,
  p_domain text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    public.storefront_store_policies(public.storefront_tenant_id(p_slug, p_domain))
      -> 'payments' -> 'methods',
    '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- `revoke ... from public` first, and then the explicit grants. A revoke from a
-- named role does not take back what that role holds through PUBLIC, and the
-- Postgres image hands EXECUTE on every new function to PUBLIC at CREATE time.
revoke all on function public.hhmm_minutes(text)                            from public;
revoke all on function public.storefront_store_policies(uuid)               from public;
revoke all on function public.storefront_store_json(uuid)                   from public;
revoke all on function public.storefront_payment_methods(text, text)        from public;

grant execute on function public.hhmm_minutes(text)                     to anon, authenticated, service_role;
grant execute on function public.storefront_store_policies(uuid)        to anon, authenticated, service_role;
grant execute on function public.storefront_store_json(uuid)            to anon, authenticated, service_role;
grant execute on function public.storefront_payment_methods(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- `payments.online_enabled` starts meaning something today, and for a store that
-- already has a live Xendit account the honest value is the one that keeps its
-- checkout exactly as it is. `do update` rather than `do nothing` deliberately:
-- every such store currently has the seeded `false` sitting in the row while
-- offering online payment anyway, so leaving it would switch off a working
-- checkout on deploy. Stores without an account are untouched — their `false` is
-- both what the row says and what a buyer sees.
insert into public.tenant_settings (tenant_id, key, value)
select t.id, 'payments.online_enabled', 'true'::jsonb
from public.tenants t
where exists (
  select 1 from public.payment_accounts a
  where a.tenant_id = t.id and a.provider = 'xendit' and a.is_enabled)
on conflict (tenant_id, key) do update set value = 'true'::jsonb;
