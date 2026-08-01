/**
 * Phase 19 — Billing, super admin & white-label.
 *
 * The done-when is a sentence about *absence*: "a reseller can onboard and bill
 * their own seller **without you touching anything**." So the test of this phase
 * is not that the screens exist, it is that there is no step in the middle where
 * a human at Selld has to do something. Every place that would have needed one —
 * creating the sub-tenant, setting its price, raising the invoice, applying the
 * payment, lifting the restriction — is a function the reseller can call.
 *
 * ## Two new boundaries, and they are the widest in the schema
 *
 * Every phase so far has had one question: *is the caller a member of this
 * tenant*. This one adds two roles that are deliberately **not** scoped to a
 * tenant, which makes them the most dangerous things here:
 *
 *   **platform admin** — sees every store. Needed for a tenant list, MRR and
 *   support. Held in `platform_admins`, which has RLS on, no policy at all, and
 *   is not writable by any client role: the only way in is a migration or the
 *   service role, because a table that can grant membership of itself is a
 *   privilege-escalation waiting to be found.
 *
 *   **reseller** — sees the stores it owns and no others. `tenants.reseller_id`
 *   is the whole of it, and `is_reseller_of(tenant_id)` is the boundary. A
 *   reseller is emphatically *not* a platform admin: it can bill its own sellers
 *   and cannot see anybody else's.
 *
 * ## Impersonation is a written record first and an access grant second
 *
 * A support person acting as a seller is the single most abusable thing in a
 * multi-tenant product, and "we log it" is worth nothing if the log is written
 * afterwards by the same code path that could skip it. So `impersonate_begin()`
 * *inserts the audit row and returns its id*, and `is_impersonating()` reads
 * that row. There is no way to gain the access without leaving the record,
 * because the record is what the access is derived from. Sessions expire on
 * their own — an hour — so a forgotten one closes itself.
 *
 * ## Limits are enforced here, not on a screen
 *
 * "At the API layer, not just UI" — and in this architecture the API layer *is*
 * the database. A limit checked in React is a limit that a `curl` with the anon
 * key ignores. So the product and user limits are triggers, which hold even
 * inside a `SECURITY DEFINER` function, and the feature gates are checks inside
 * the functions those features are reached through.
 *
 * The exception is deliberate and is stated in `enforce_plan_limit` below: a
 * **buyer's checkout must never fail because of the seller's billing status.**
 * Punishing a stranger for someone else's overdue invoice loses the seller the
 * sale, and a seller who cannot take money is a seller who cancels rather than
 * upgrades.
 */

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------
/**
 * What a store may do, and what it costs.
 *
 * `limits` is JSONB rather than columns because the *set* of limits changes far
 * more often than the plans do — phase 20 will want an API rate limit, phase 21
 * a storage cap — and each of those would otherwise be a migration plus a types
 * regeneration. `plan_limit()` below is the compensating control: one place that
 * knows the keys, so a typo cannot silently mean "unlimited".
 *
 * `null` in a limit means unlimited. Zero means zero, which is a different thing
 * and the reason this is not a plain integer with a magic sentinel.
 */
create table public.plans (
  id    uuid not null default gen_random_uuid(),
  code  text not null,
  name  text not null,
  description text,

  price_centavos public.centavos not null default 0,
  /** Billing period in months. 1 for monthly, 12 for an annual plan. */
  interval_months int not null default 1 check (interval_months in (1, 3, 6, 12)),

  /**
   * `{"maxProducts": 50, "maxUsers": 2, "maxOrdersPerMonth": 200,
   *   "features": ["live", "broadcasts"]}`
   */
  limits jsonb not null default '{}'::jsonb,

  /**
   * A plan a reseller sells to its own sellers rather than one Selld sells.
   * Kept in the same table because everything about them is the same except who
   * gets paid, and two tables would mean two enforcement paths.
   */
  reseller_id uuid,

  is_public  boolean not null default true,
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  -- Codes are unique per owner: Selld's `starter` and a reseller's `starter` are
  -- different plans, and a reseller must not be able to collide with ours.
  unique nulls not distinct (reseller_id, code)
);

create index plans_reseller_idx on public.plans (reseller_id);

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Resellers
-- ---------------------------------------------------------------------------
/**
 * A white-label partner that owns sub-tenants.
 *
 * The done-when's subject. A reseller signs its own sellers up, sets its own
 * prices, brands the dashboard, and takes a cut — and Selld's involvement is a
 * revenue-share percentage and nothing else.
 *
 * `commission_bps` is what *Selld* keeps of what the reseller bills. Stated in
 * that direction on purpose: a reseller reading their own screen should see what
 * they earn, and the platform's cut should be the thing subtracted, not the
 * thing reported.
 */
create table public.resellers (
  id   uuid not null default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$'),

  contact_email text,
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+63[0-9]{9,10}$'),

  /** What Selld keeps of what the reseller bills its sellers. */
  commission_bps int not null default 2000 check (commission_bps between 0 and 10000),

  -- White label.
  brand_name  text,
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  logo_path   text,
  support_email text,

  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id)
);

create trigger resellers_set_updated_at
  before update on public.resellers
  for each row execute function public.set_updated_at();

/**
 * Who may act for a reseller.
 *
 * A join table rather than a column on `profiles`, because a reseller is an
 * organisation and organisations have more than one person — and because the
 * alternative, a `is_reseller` flag on a user, cannot express *which* reseller.
 */
create table public.reseller_members (
  id          uuid not null default gen_random_uuid(),
  reseller_id uuid not null references public.resellers (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        text not null default 'admin' check (role in ('owner', 'admin', 'support')),
  created_at  timestamptz not null default now(),

  primary key (id),
  unique (reseller_id, user_id)
);

create index reseller_members_user_idx on public.reseller_members (user_id);

alter table public.plans
  add constraint plans_reseller_fk
  foreign key (reseller_id) references public.resellers (id) on delete cascade;

/** Which reseller, if any, owns this store. */
alter table public.tenants
  add column if not exists reseller_id uuid references public.resellers (id) on delete set null;

create index tenants_reseller_idx on public.tenants (reseller_id) where reseller_id is not null;

-- ---------------------------------------------------------------------------
-- Platform admins
-- ---------------------------------------------------------------------------
/**
 * Selld's own staff.
 *
 * RLS on, **no policy at all**, and no grants to any client role — the same
 * shape as `social_accounts` and `marketplace_connections`, and here for a
 * sharper reason: those tables hold a secret, this one holds *authority*. A
 * table that a client could insert into is a table that grants its own
 * membership, which is the shortest privilege-escalation path there is.
 *
 * The only ways in are a migration and the service role.
 */
create table public.platform_admins (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role    text not null default 'support' check (role in ('owner', 'support', 'billing')),
  note    text,
  created_at timestamptz not null default now(),

  primary key (user_id)
);

/**
 * Is the caller Selld staff?
 *
 * `SECURITY DEFINER` with an empty `search_path`, like every other boundary
 * helper — a policy on `platform_admins` that queried `platform_admins` would
 * recurse forever, and the same care applies to anything that reads it.
 */
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a where a.user_id = auth.uid());
$$;

/** Does the caller act for the reseller that owns this store? */
create or replace function public.is_reseller_of(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenants t
      join public.reseller_members m on m.reseller_id = t.reseller_id
    where t.id = p_tenant_id
      and t.reseller_id is not null
      and m.user_id = auth.uid());
$$;

/** The reseller the caller acts for, if any. */
create or replace function public.current_reseller()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.reseller_id from public.reseller_members m
  where m.user_id = auth.uid()
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Impersonation
-- ---------------------------------------------------------------------------
/**
 * A support person acting as a seller, and the record that makes it accountable.
 *
 * The row is written *first* and the access is derived *from* it — see the file
 * header. Three properties follow, and each of them is the reason for a column:
 *
 *   - a reason is **required**, because "why were you in my store" is the
 *     question this table exists to answer;
 *   - sessions expire on their own, so a forgotten one is not an open door;
 *   - the table is append-only for everybody, including the admin who wrote the
 *     row. A log the subject cannot trust is not an audit trail.
 *
 * A seller can read their own store's rows. That is the point: the accountability
 * is *to them*, not to us.
 */
create table public.impersonation_sessions (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  actor_id  uuid not null references public.profiles (id) on delete cascade,

  reason text not null check (length(btrim(reason)) >= 8),
  /** How the actor came to have the right: platform staff, or the reseller. */
  actor_kind text not null check (actor_kind in ('platform', 'reseller')),

  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  ended_at   timestamptz,

  primary key (id)
);

create index impersonation_tenant_idx on public.impersonation_sessions (tenant_id, started_at desc);
create index impersonation_active_idx on public.impersonation_sessions (actor_id, expires_at)
  where ended_at is null;

/**
 * An impersonation record is written once and never edited.
 *
 * Without this, an actor could extend their own session or blank the reason
 * after the fact — and an audit trail its subject cannot trust is decoration.
 * Only `ended_at` may be set, and only once, so a session can be closed early.
 */
create or replace function public.impersonation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- The parent's cascade is allowed: on a tenant delete the row is going away
    -- with everything else, and that is distinguishable because the tenant is
    -- already gone by the time this fires.
    if exists (select 1 from public.tenants where id = old.tenant_id) then
      raise exception 'An impersonation record cannot be deleted'
        using errcode = 'check_violation', hint = 'impersonation_append_only';
    end if;
    return old;
  end if;

  if new.tenant_id is distinct from old.tenant_id
     or new.actor_id is distinct from old.actor_id
     or new.reason  is distinct from old.reason
     or new.actor_kind is distinct from old.actor_kind
     or new.started_at is distinct from old.started_at
     or new.expires_at is distinct from old.expires_at
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
    raise exception 'An impersonation record cannot be edited, only ended'
      using errcode = 'check_violation', hint = 'impersonation_append_only';
  end if;
  return new;
end;
$$;

create trigger impersonation_append_only
  before update or delete on public.impersonation_sessions
  for each row execute function public.impersonation_guard();

/**
 * Start acting as a store. Returns the audit row's id.
 *
 * Service-role only, because the caller has to be authenticated as themselves
 * and the *server* decides that this is an impersonation rather than the client
 * asserting it. The reason is not optional and the length check is a real check:
 * "test" is not a reason.
 */
create or replace function public.impersonate_begin(
  p_actor_id  uuid,
  p_tenant_id uuid,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_id   uuid;
begin
  if exists (select 1 from public.platform_admins where user_id = p_actor_id) then
    v_kind := 'platform';
  elsif exists (
    select 1 from public.tenants t
      join public.reseller_members m on m.reseller_id = t.reseller_id
    where t.id = p_tenant_id and m.user_id = p_actor_id) then
    v_kind := 'reseller';
  else
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.impersonation_sessions (tenant_id, actor_id, reason, actor_kind)
  values (p_tenant_id, p_actor_id, btrim(p_reason), v_kind)
  returning id into v_id;

  return jsonb_build_object('sessionId', v_id, 'kind', v_kind,
                            'expiresAt', now() + interval '1 hour');
end;
$$;

/** Stop early. Expiry does the rest on its own. */
create or replace function public.impersonate_end(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.impersonation_sessions
     set ended_at = now()
   where id = p_session_id and ended_at is null;
end;
$$;

/** Is this caller currently, verifiably, acting as this store? */
create or replace function public.is_impersonating(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.impersonation_sessions s
    where s.tenant_id = p_tenant_id
      and s.actor_id = auth.uid()
      and s.ended_at is null
      and s.expires_at > now());
$$;

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
/**
 * One store's plan, and where it is in the billing cycle.
 *
 * The status ladder is the dunning design, and the order of it matters more than
 * any single state:
 *
 *   `trialing`    → free, full access, ends on a date
 *   `active`      → paid, full access
 *   `past_due`    → an invoice failed. **Full access.** A grace period, because
 *                   a card that bounced on a Tuesday is usually a card, not a
 *                   decision.
 *   `restricted`  → grace expired. The seller cannot add products or staff, and
 *                   the *storefront keeps working*. Buyers are not punished for
 *                   an unpaid invoice.
 *   `cancelled`   → over. Data is kept; nothing is deleted by billing, ever.
 *
 * There is no state in which a buyer cannot check out. That is a deliberate
 * commercial choice as much as an ethical one: a seller whose store goes dark
 * churns, a seller who cannot add a product upgrades.
 */
create table public.subscriptions (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  plan_id   uuid not null references public.plans (id),

  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'restricted', 'cancelled')),

  /** What this store is actually charged — a reseller may discount its own. */
  price_centavos public.centavos not null default 0,

  trial_ends_at        timestamptz,
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null default now() + interval '1 month',
  /** Set when the seller cancels; access continues until the period ends. */
  cancel_at   timestamptz,
  cancelled_at timestamptz,

  /** When `past_due` becomes `restricted`. Set on the first failed invoice. */
  grace_ends_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  -- One subscription per store. A second row is not an upgrade, it is a
  -- double charge.
  unique (tenant_id),
  unique (tenant_id, id)
);

create index subscriptions_status_idx on public.subscriptions (status, current_period_end);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

/**
 * What a store owes, and whether it has paid.
 *
 * `xendit_invoice_id` is unique so the webhook is idempotent by construction —
 * the same lesson `orders.channel_ref` learned in phase 17, and the same lesson
 * `webhook_events.external_id` learned in phase 8. A provider that retries a
 * callback is not an edge case; it is Tuesday.
 */
create table public.subscription_invoices (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  subscription_id uuid not null,

  amount_centavos public.centavos not null check (amount_centavos >= 0),
  /** What Selld keeps when a reseller billed this. Zero when Selld billed. */
  platform_cut_centavos public.centavos not null default 0,

  status text not null default 'open'
    check (status in ('open', 'paid', 'failed', 'void')),
  period_start timestamptz not null,
  period_end   timestamptz not null,

  xendit_invoice_id text,
  checkout_url text,
  paid_at   timestamptz,
  failed_at timestamptz,
  attempts  int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id),
  foreign key (tenant_id, subscription_id)
    references public.subscriptions (tenant_id, id) on delete cascade,
  unique (xendit_invoice_id)
);

create index subscription_invoices_tenant_idx
  on public.subscription_invoices (tenant_id, created_at desc);

create trigger subscription_invoices_set_updated_at
  before update on public.subscription_invoices
  for each row execute function public.set_updated_at();

/**
 * SMS credits, bought outright.
 *
 * Separate from the subscription because it is a different kind of purchase: a
 * subscription recurs and a credit pack does not, and putting a one-off on the
 * same invoice would make "what do I owe every month" unanswerable.
 */
create table public.credit_purchases (
  id        uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  credits int not null check (credits > 0),
  amount_centavos public.centavos not null check (amount_centavos >= 0),
  status text not null default 'open' check (status in ('open', 'paid', 'failed', 'void')),

  xendit_invoice_id text unique,
  checkout_url text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id)
);

create index credit_purchases_tenant_idx on public.credit_purchases (tenant_id, created_at desc);

create trigger credit_purchases_set_updated_at
  before update on public.credit_purchases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
/**
 * A banner from Selld, or from a reseller to its own sellers.
 *
 * `reseller_id is null` means it is from Selld and goes to everybody; a
 * reseller's goes only to the stores it owns. There is no way to write one
 * addressed to somebody else's sellers, which is the whole of the authorisation
 * on this table.
 */
create table public.announcements (
  id      uuid not null default gen_random_uuid(),
  reseller_id uuid references public.resellers (id) on delete cascade,

  title text not null,
  body  text not null,
  level text not null default 'info' check (level in ('info', 'warning', 'critical')),

  starts_at timestamptz not null default now(),
  ends_at   timestamptz,
  is_active boolean not null default true,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (id)
);

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The plan catalogue
-- ---------------------------------------------------------------------------
/**
 * Selld's own plans.
 *
 * Seeded in the migration rather than by a script, because `plan_limit()` has to
 * have an answer for every store from the first second the schema exists — a
 * limit lookup that returns "no plan, therefore no restriction" is a limit that
 * is off by default, and off-by-default is how a limit ships broken.
 *
 * `null` for a limit is unlimited. `0` would be zero, which is why the sentinel
 * is null and not a number.
 */
insert into public.plans (code, name, description, price_centavos, limits, sort_order)
values
  ('free', 'Free', 'Enough to open a store and take your first orders.', 0,
   '{"maxProducts": 20, "maxUsers": 1, "maxOrdersPerMonth": 50, "features": []}'::jsonb, 0),
  ('starter', 'Starter', 'For a seller doing this every day.', 49900,
   '{"maxProducts": 200, "maxUsers": 3, "maxOrdersPerMonth": 500,
     "features": ["live", "broadcasts"]}'::jsonb, 1),
  ('growth', 'Growth', 'Live selling, broadcasts and marketplace sync.', 149900,
   '{"maxProducts": 2000, "maxUsers": 10, "maxOrdersPerMonth": 5000,
     "features": ["live", "broadcasts", "marketplaces"]}'::jsonb, 2),
  ('scale', 'Scale', 'No limits, and your own brand on it.', 399900,
   '{"maxProducts": null, "maxUsers": null, "maxOrdersPerMonth": null,
     "features": ["live", "broadcasts", "marketplaces", "white_label"]}'::jsonb, 3)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Reading a limit
-- ---------------------------------------------------------------------------
/**
 * The plan limit for a store, or null for unlimited.
 *
 * The compensating control the `limits` JSONB comment promised: one place that
 * knows the key names, so a typo is a null here rather than an unlimited store.
 * The key list is checked, not just read — `plan_limit(t, 'maxProdcuts')` raises
 * instead of quietly answering "unlimited".
 *
 * No authorisation, and not granted to anyone: it is called from inside the
 * triggers and definers below, which already run as the owner.
 */
create or replace function public.plan_limit(p_tenant_id uuid, p_key text)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits jsonb;
begin
  if p_key not in ('maxProducts', 'maxUsers', 'maxOrdersPerMonth') then
    raise exception 'Unknown plan limit "%"', p_key using errcode = 'check_violation';
  end if;

  select p.limits into v_limits
  from public.subscriptions s
    join public.plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant_id;

  -- A store with no subscription row predates billing. It is not unlimited and
  -- it is not free either — it is simply not yet enrolled, and the honest answer
  -- is "no limit is being applied", which the backfill below then makes moot.
  if v_limits is null then return null; end if;

  return (v_limits ->> p_key)::int;
end;
$$;

/**
 * Does this store's plan include a feature?
 *
 * Absent subscription means yes, for the same reason as above and one more: this
 * is called from triggers on tables that existed before this phase, and a
 * migration that switches every existing store's live selling off at 3am is not
 * a feature gate, it is an outage.
 */
create or replace function public.plan_has_feature(p_tenant_id uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits jsonb;
begin
  select p.limits into v_limits
  from public.subscriptions s
    join public.plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant_id;

  if v_limits is null then return true; end if;
  return coalesce(v_limits -> 'features', '[]'::jsonb) ? p_feature;
end;
$$;

/**
 * Is this store's billing in a state that allows *adding* things?
 *
 * `restricted` is the only no, and it is deliberately narrow. Read the ladder on
 * `subscriptions`: `past_due` still says yes, because a failed card is usually a
 * card. And nothing here is ever consulted on a buyer's path — see
 * `enforce_plan_limit`.
 */
create or replace function public.billing_allows_writes(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.status not in ('restricted', 'cancelled')
     from public.subscriptions s where s.tenant_id = p_tenant_id),
    true);
$$;

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------
/**
 * The product and staff ceilings, as triggers.
 *
 * A trigger and not a check inside `create_product`, because a limit is only a
 * limit if it holds on *every* path that can write the row — including the
 * `SECURITY DEFINER` importers, including a future bulk endpoint, and including
 * `curl` with the anon key against PostgREST. That is what "at the API layer, not
 * just UI" has to mean in an architecture where the database *is* the API layer.
 *
 * Counted with `count(*)` rather than a maintained counter on purpose. A cached
 * count that drifts under-reports, and an under-reporting limit is no limit;
 * these tables are hundreds of rows, not millions.
 */
/*
 * All six trigger functions below are `SECURITY DEFINER`, and that is not
 * decoration. A trigger function runs as the *invoker* by default, so a guard
 * that calls `plan_limit()` — which is granted to nobody, on purpose — raises
 * `permission denied` for every ordinary `authenticated` write. The failure is
 * loud rather than silent, which is the one mercy: a seller inviting a colleague
 * gets an error about a function they have never heard of, and the tenancy suite
 * is what said so.
 *
 * Definer is also the *correct* right here for a second reason: a limit is
 * counted across the whole tenant, and a count taken under the caller's RLS is a
 * count of the rows that caller can see.
 */
create or replace function public.enforce_product_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max  int := public.plan_limit(new.tenant_id, 'maxProducts');
  v_have int;
begin
  if not public.billing_allows_writes(new.tenant_id) then
    raise exception 'Your subscription is not active, so new products cannot be added'
      using errcode = 'check_violation', hint = 'billing_restricted';
  end if;
  if v_max is null then return new; end if;

  select count(*) into v_have from public.products where tenant_id = new.tenant_id;
  if v_have >= v_max then
    raise exception 'Your plan allows % products', v_max
      using errcode = 'check_violation', hint = 'plan_limit_products';
  end if;
  return new;
end;
$$;

create trigger products_plan_limit
  before insert on public.products
  for each row execute function public.enforce_product_limit();

/**
 * The seat ceiling.
 *
 * On `tenant_members` and on `invitations` both, because an invitation that can
 * be sent and never redeemed is a limit that reports the wrong number to the
 * seller — they invite five people, three bounce off a limit they were never
 * told about, and the failure surfaces to the *invitee*.
 */
create or replace function public.enforce_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max  int := public.plan_limit(new.tenant_id, 'maxUsers');
  v_have int;
begin
  if not public.billing_allows_writes(new.tenant_id) then
    raise exception 'Your subscription is not active, so new users cannot be added'
      using errcode = 'check_violation', hint = 'billing_restricted';
  end if;
  if v_max is null then return new; end if;

  select (select count(*) from public.tenant_members where tenant_id = new.tenant_id)
       + (select count(*) from public.invitations
          where tenant_id = new.tenant_id and accepted_at is null and expires_at > now())
    into v_have;

  if v_have >= v_max then
    raise exception 'Your plan allows % users', v_max
      using errcode = 'check_violation', hint = 'plan_limit_users';
  end if;
  return new;
end;
$$;

create trigger tenant_members_plan_limit
  before insert on public.tenant_members
  for each row execute function public.enforce_seat_limit();

create trigger invitations_plan_limit
  before insert on public.invitations
  for each row execute function public.enforce_seat_limit();

/**
 * The order ceiling — and the exception that is the whole point of this phase.
 *
 * A monthly order limit is a real plan lever, and it is the one limit that must
 * **never** be enforced against a buyer. `source = 'storefront'`, `'live'` and
 * `'marketplace'` are all somebody else's checkout: the person on the other end
 * has no idea the seller's card bounced, cannot fix it, and would simply lose the
 * thing they were buying. Blocking those punishes a stranger for a seller's
 * invoice and costs the seller the sale — which makes them cancel, not upgrade.
 *
 * So the ceiling applies to `manual` only: the seller typing an order in on the
 * dashboard. That is the seller's own hand, on the seller's own screen, where the
 * message "you are over your plan" is both actionable and true. Everything else
 * is counted and reported and never refused.
 */
create or replace function public.enforce_order_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max  int;
  v_have int;
begin
  if new.source <> 'manual' then return new; end if;

  v_max := public.plan_limit(new.tenant_id, 'maxOrdersPerMonth');
  if v_max is null then return new; end if;

  select count(*) into v_have
  from public.orders
  where tenant_id = new.tenant_id
    and (placed_at at time zone 'Asia/Manila')::date
        >= date_trunc('month', (now() at time zone 'Asia/Manila'))::date;

  if v_have >= v_max then
    raise exception 'Your plan allows % orders a month', v_max
      using errcode = 'check_violation', hint = 'plan_limit_orders';
  end if;
  return new;
end;
$$;

create trigger orders_plan_limit
  before insert on public.orders
  for each row execute function public.enforce_order_limit();

/**
 * Feature gates, on the tables rather than in the functions that reach them.
 *
 * Putting the gate on `insert into live_sessions` instead of inside
 * `live_session_start()` means it also holds for the marketplace importer, the
 * webhook path, and anything phase 20 adds — and it means this migration does not
 * have to re-create four large functions from earlier phases just to add one line
 * to each, which is how a re-creation quietly reverts a later fix.
 */
create or replace function public.enforce_feature_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feature text := tg_argv[0];
begin
  if not public.billing_allows_writes(new.tenant_id) then
    raise exception 'Your subscription is not active'
      using errcode = 'check_violation', hint = 'billing_restricted';
  end if;
  if not public.plan_has_feature(new.tenant_id, v_feature) then
    raise exception 'Your plan does not include %', v_feature
      using errcode = 'check_violation', hint = 'plan_feature_' || v_feature;
  end if;
  return new;
end;
$$;

create trigger live_sessions_feature_gate
  before insert on public.live_sessions
  for each row execute function public.enforce_feature_gate('live');

create trigger broadcasts_feature_gate
  before insert on public.broadcasts
  for each row execute function public.enforce_feature_gate('broadcasts');

create trigger marketplace_connections_feature_gate
  before insert on public.marketplace_connections
  for each row execute function public.enforce_feature_gate('marketplaces');

-- ---------------------------------------------------------------------------
-- Every store has a subscription, from the moment it exists
-- ---------------------------------------------------------------------------
/**
 * A store with no subscription row is a store no limit applies to, and
 * `plan_limit()` says so out loud. That is the right answer to give and the wrong
 * state to leave a store in, so there are exactly two ways a store can be in it:
 * never, and never.
 *
 * A new store gets a 14-day trial of **Growth**, not of the entry plan. Trialing
 * is full access, and it is full access to the *whole* product: a seller cannot
 * decide whether live selling or marketplace sync is worth ₱1,499 if the trial
 * hides both behind the plan they have not bought yet. A trial that withholds the
 * thing being trialled sells nothing.
 *
 * It is also what keeps every earlier phase's proof honest. Phase 13's live board
 * and phase 17's Shopee sync are exercised against a store created a minute
 * earlier; putting that store on a plan without those features would have broken
 * two working features on the morning this migration deployed, and the first
 * symptom would have been a test failing for a reason that has nothing to do with
 * what it tests.
 *
 * A store a reseller creates is overwritten a moment later by
 * `reseller_create_tenant()`, which sets the reseller's own plan and price. It is
 * still created here first, because the alternative is a window in which the row
 * does not exist.
 */
create or replace function public.bootstrap_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans;
begin
  select * into v_plan from public.plans
  where code = 'growth' and reseller_id is null;
  if v_plan.id is null then return new; end if;

  insert into public.subscriptions
    (tenant_id, plan_id, status, price_centavos, trial_ends_at,
     current_period_start, current_period_end)
  values
    (new.id, v_plan.id, 'trialing', v_plan.price_centavos, now() + interval '14 days',
     now(), now() + interval '14 days')
  on conflict (tenant_id) do nothing;

  return new;
end;
$$;

create trigger tenants_bootstrap_subscription
  after insert on public.tenants
  for each row execute function public.bootstrap_subscription();

/**
 * The stores that already exist.
 *
 * Growth, trialing, 30 days — not Free. Every one of these sellers signed up when
 * there were no plans and no limits, and dropping them onto a 20-product ceiling
 * on the morning this deploys would break stores that were working the night
 * before, for a bill they were never shown. A month of the plan they have been
 * behaving as if they had is the smallest honest way to introduce one.
 */
insert into public.subscriptions
  (tenant_id, plan_id, status, price_centavos, trial_ends_at,
   current_period_start, current_period_end)
select t.id, p.id, 'trialing', p.price_centavos, now() + interval '30 days',
       now(), now() + interval '30 days'
from public.tenants t
  cross join public.plans p
where p.code = 'growth' and p.reseller_id is null
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- Visibility helpers
-- ---------------------------------------------------------------------------
/**
 * Whose plans a caller may see.
 *
 * Written as a `SECURITY DEFINER` helper rather than inlined into the policy for
 * the reason the tenancy migration learned the hard way: a policy on a table that
 * reads that table recurses forever, and a policy that reads `tenant_members`
 * reads a table with its own policy. Definer plus an empty `search_path` is the
 * house pattern for every boundary predicate here.
 */
create or replace function public.plan_is_visible(p_reseller_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_reseller_id is null
      or public.is_platform_admin()
      or exists (select 1 from public.reseller_members m
                 where m.reseller_id = p_reseller_id and m.user_id = auth.uid())
      or exists (select 1 from public.tenants t
                   join public.tenant_members tm on tm.tenant_id = t.id
                 where t.reseller_id = p_reseller_id and tm.user_id = auth.uid());
$$;

/** Whose reseller record a caller may see: their own, their store's, or all. */
create or replace function public.reseller_is_visible(p_reseller_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_platform_admin()
      or exists (select 1 from public.reseller_members m
                 where m.reseller_id = p_reseller_id and m.user_id = auth.uid())
      or exists (select 1 from public.tenants t
                   join public.tenant_members tm on tm.tenant_id = t.id
                 where t.reseller_id = p_reseller_id and tm.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Every table in this file is readable through a policy and writable through
-- nothing. There is not one `insert`, `update` or `delete` grant to a client role
-- below: billing state is written by the webhook worker and by checked functions,
-- because "the seller can set their own subscription status" is the same sentence
-- as "the seller can set their own price".

alter table public.plans                  enable row level security;
alter table public.plans                  force  row level security;
alter table public.resellers              enable row level security;
alter table public.resellers              force  row level security;
alter table public.reseller_members       enable row level security;
alter table public.reseller_members       force  row level security;
alter table public.platform_admins        enable row level security;
alter table public.platform_admins        force  row level security;
alter table public.impersonation_sessions enable row level security;
alter table public.impersonation_sessions force  row level security;
alter table public.subscriptions          enable row level security;
alter table public.subscriptions          force  row level security;
alter table public.subscription_invoices  enable row level security;
alter table public.subscription_invoices  force  row level security;
alter table public.credit_purchases       enable row level security;
alter table public.credit_purchases       force  row level security;
alter table public.announcements          enable row level security;
alter table public.announcements          force  row level security;

-- `platform_admins` gets no policy at all, on purpose. See the table comment: it
-- holds authority rather than a secret, and a client that can read the list of
-- Selld staff has the target list for a phishing campaign.

create policy "Read plans" on public.plans for select to authenticated
  using (public.plan_is_visible(reseller_id));

create policy "Read resellers" on public.resellers for select to authenticated
  using (public.reseller_is_visible(id));

create policy "Read reseller members" on public.reseller_members for select to authenticated
  using (public.reseller_is_visible(reseller_id));

/**
 * A seller reads their own store's impersonation log.
 *
 * This is the load-bearing policy of the whole audit design. The accountability
 * is to the seller, not to us — if only Selld could read the record of Selld
 * entering a seller's store, the record would be for our comfort rather than
 * their protection.
 */
create policy "Read impersonation log" on public.impersonation_sessions
  for select to authenticated
  using (public.is_tenant_member(tenant_id)
         or public.is_reseller_of(tenant_id)
         or public.is_platform_admin());

create policy "Read subscription" on public.subscriptions for select to authenticated
  using (public.is_tenant_member(tenant_id)
         or public.is_reseller_of(tenant_id)
         or public.is_platform_admin());

create policy "Read invoices" on public.subscription_invoices for select to authenticated
  using (public.is_tenant_member(tenant_id)
         or public.is_reseller_of(tenant_id)
         or public.is_platform_admin());

create policy "Read credit purchases" on public.credit_purchases for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Read announcements" on public.announcements for select to authenticated
  using (reseller_id is null or public.reseller_is_visible(reseller_id));

-- ---------------------------------------------------------------------------
-- What a seller sees
-- ---------------------------------------------------------------------------
/**
 * Usage against the plan, as one document.
 *
 * `usage` sits next to `limits` in the same payload deliberately. A billing
 * screen that shows a plan without showing how close the store is to its edges
 * makes the seller find out at the moment they are blocked, which is the moment
 * they are trying to do something.
 *
 * `billedBy` names the reseller when there is one. A seller on a white-label plan
 * is billed by their reseller and should never see Selld's name on the screen;
 * they also should never be *unable to find out* who is charging them.
 */
create or replace function public.subscription_overview(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sub  public.subscriptions;
  v_plan public.plans;
  v_res  public.resellers;
  v_month_start date := date_trunc('month', (now() at time zone 'Asia/Manila'))::date;
begin
  if not public.is_tenant_member(p_tenant_id)
     and not public.is_reseller_of(p_tenant_id)
     and not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select * into v_sub from public.subscriptions where tenant_id = p_tenant_id;
  if v_sub.id is null then return null; end if;

  select * into v_plan from public.plans where id = v_sub.plan_id;
  select r.* into v_res from public.resellers r
    join public.tenants t on t.reseller_id = r.id
  where t.id = p_tenant_id;

  return jsonb_build_object(
    'status', v_sub.status,
    'priceCentavos', v_sub.price_centavos,
    'trialEndsAt', v_sub.trial_ends_at,
    'currentPeriodStart', v_sub.current_period_start,
    'currentPeriodEnd', v_sub.current_period_end,
    'cancelAt', v_sub.cancel_at,
    'graceEndsAt', v_sub.grace_ends_at,
    'plan', jsonb_build_object(
      'id', v_plan.id, 'code', v_plan.code, 'name', v_plan.name,
      'description', v_plan.description,
      'priceCentavos', v_plan.price_centavos,
      'intervalMonths', v_plan.interval_months,
      'limits', v_plan.limits),
    'usage', jsonb_build_object(
      'products', (select count(*) from public.products where tenant_id = p_tenant_id),
      'users', (select count(*) from public.tenant_members where tenant_id = p_tenant_id)
             + (select count(*) from public.invitations
                where tenant_id = p_tenant_id and accepted_at is null and expires_at > now()),
      'ordersThisMonth', (select count(*) from public.orders
        where tenant_id = p_tenant_id
          and (placed_at at time zone 'Asia/Manila')::date >= v_month_start)),
    'smsCredits', public.sms_credit_balance_raw(p_tenant_id),
    'billedBy', case when v_res.id is null then null else jsonb_build_object(
      'name', coalesce(v_res.brand_name, v_res.name),
      'supportEmail', v_res.support_email) end,
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'amountCentavos', i.amount_centavos, 'status', i.status,
               'periodStart', i.period_start, 'periodEnd', i.period_end,
               'checkoutUrl', case when i.status = 'open' then i.checkout_url end,
               'paidAt', i.paid_at, 'createdAt', i.created_at)
             order by i.created_at desc)
      from (select * from public.subscription_invoices
            where tenant_id = p_tenant_id order by created_at desc limit 12) i), '[]'::jsonb)
  );
end;
$$;

/**
 * The plans this store may move to.
 *
 * A reseller's store sees the reseller's catalogue and *only* that. Showing Selld's
 * ₱499 Starter to a seller whose reseller charges ₱899 for the same thing is
 * showing them a price they cannot buy at, from a company they have no
 * relationship with.
 */
create or replace function public.subscription_plans(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reseller uuid;
begin
  if not public.is_tenant_member(p_tenant_id)
     and not public.is_reseller_of(p_tenant_id)
     and not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select reseller_id into v_reseller from public.tenants where id = p_tenant_id;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name, 'description', p.description,
             'priceCentavos', p.price_centavos, 'intervalMonths', p.interval_months,
             'limits', p.limits)
           order by p.sort_order, p.price_centavos)
    from public.plans p
    where p.is_active and p.is_public
      and p.reseller_id is not distinct from v_reseller), '[]'::jsonb);
end;
$$;

/**
 * Change plan.
 *
 * An upgrade takes effect now; a downgrade is refused when the store is already
 * over the smaller plan's ceiling, with the number in the message. Silently
 * accepting it and then blocking the *next* product is worse: the seller has
 * agreed to a plan whose consequence is invisible until it bites, and the row
 * they cannot add is not the row that put them over.
 */
create or replace function public.subscription_change_plan(p_tenant_id uuid, p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub  public.subscriptions;
  v_plan public.plans;
  v_reseller uuid;
  v_have int;
  v_max  int;
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select reseller_id into v_reseller from public.tenants where id = p_tenant_id;
  select * into v_plan from public.plans
  where id = p_plan_id and is_active and reseller_id is not distinct from v_reseller;
  if v_plan.id is null then
    raise exception 'That plan is not available for this store'
      using errcode = 'check_violation', hint = 'plan_not_available';
  end if;

  select * into v_sub from public.subscriptions where tenant_id = p_tenant_id for update;

  v_max := (v_plan.limits ->> 'maxProducts')::int;
  select count(*) into v_have from public.products where tenant_id = p_tenant_id;
  if v_max is not null and v_have > v_max then
    raise exception 'You have % products and % allows %', v_have, v_plan.name, v_max
      using errcode = 'check_violation', hint = 'downgrade_products';
  end if;

  v_max := (v_plan.limits ->> 'maxUsers')::int;
  select count(*) into v_have from public.tenant_members where tenant_id = p_tenant_id;
  if v_max is not null and v_have > v_max then
    raise exception 'You have % users and % allows %', v_have, v_plan.name, v_max
      using errcode = 'check_violation', hint = 'downgrade_users';
  end if;

  update public.subscriptions
     set plan_id = v_plan.id,
         price_centavos = v_plan.price_centavos,
         -- A trial keeps running: changing plan mid-trial is a seller exploring,
         -- not a seller buying, and charging them for the curiosity is a way to
         -- teach them not to explore.
         status = case when v_sub.status in ('restricted', 'cancelled') then 'active'
                       else v_sub.status end,
         cancel_at = null,
         cancelled_at = null,
         grace_ends_at = case when v_sub.status = 'restricted' then null else grace_ends_at end
   where tenant_id = p_tenant_id;

  return public.subscription_overview(p_tenant_id);
end;
$$;

/** Cancel at the end of the period the seller has already paid for. */
create or replace function public.subscription_cancel(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  -- Access runs to `current_period_end`. Cutting it off at the moment of
  -- cancellation charges for a month and delivers part of one.
  update public.subscriptions
     set cancel_at = current_period_end
   where tenant_id = p_tenant_id and cancelled_at is null;
  return public.subscription_overview(p_tenant_id);
end;
$$;

/** Changed their mind before the period ended. */
create or replace function public.subscription_resume(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.subscriptions
     set cancel_at = null
   where tenant_id = p_tenant_id and cancelled_at is null;
  return public.subscription_overview(p_tenant_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The billing cycle
-- ---------------------------------------------------------------------------
/**
 * Raise the invoices that are due, and hand them to the worker.
 *
 * The same split as `broadcast_claim_next` in phase 16 and `marketplace_push_claim`
 * in phase 17, for the same reason: Postgres cannot call Xendit, so the loop lives
 * in Node — and every rule the loop appears to enforce is enforced on this side of
 * the call. The invoice row is written *here*, under `for update skip locked`, and
 * only then is its body returned. A worker that dies between claiming and calling
 * Xendit leaves an open invoice that the next pass picks up; a worker that could
 * decide what to bill would be a worker whose crash loses money.
 *
 * `platform_cut_centavos` is computed at raise time from the reseller's commission
 * as it is *today*. A rate that changes must not retroactively rewrite what was
 * owed on invoices already issued.
 *
 * Service role only.
 */
create or replace function public.billing_due_claim(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_row record;
  v_invoice public.subscription_invoices;
  v_cut bigint;
begin
  for v_row in
    select s.*, t.name as tenant_name, t.slug as tenant_slug, t.reseller_id,
           r.commission_bps, coalesce(r.brand_name, r.name) as reseller_name
    from public.subscriptions s
      join public.tenants t on t.id = s.tenant_id
      left join public.resellers r on r.id = t.reseller_id
    where s.current_period_end <= now()
      and s.status in ('trialing', 'active', 'past_due')
      and s.price_centavos > 0
      and s.cancelled_at is null
      and not exists (
        select 1 from public.subscription_invoices i
        where i.subscription_id = s.id
          and i.period_start = s.current_period_end
          and i.status in ('open', 'paid'))
    order by s.current_period_end
    limit p_limit
    for update of s skip locked
  loop
    v_cut := case when v_row.reseller_id is null then 0
                  else (v_row.price_centavos * coalesce(v_row.commission_bps, 0)) / 10000 end;

    insert into public.subscription_invoices
      (tenant_id, subscription_id, amount_centavos, platform_cut_centavos,
       period_start, period_end)
    values
      (v_row.tenant_id, v_row.id, v_row.price_centavos, v_cut,
       v_row.current_period_end,
       v_row.current_period_end + make_interval(months => (
         select interval_months from public.plans where id = v_row.plan_id)))
    returning * into v_invoice;

    v_out := v_out || jsonb_build_object(
      'invoiceId', v_invoice.id,
      'tenantId', v_row.tenant_id,
      'tenantName', v_row.tenant_name,
      'tenantSlug', v_row.tenant_slug,
      'amountCentavos', v_invoice.amount_centavos,
      'platformCutCentavos', v_invoice.platform_cut_centavos,
      'billedBy', v_row.reseller_name,
      'periodStart', v_invoice.period_start,
      'periodEnd', v_invoice.period_end);
  end loop;

  /**
   * And the ones that were raised but never reached Xendit.
   *
   * Without this the file has a hole with no error in it: a gateway timeout
   * leaves an open row with no `xendit_invoice_id`, the `not exists` clause above
   * then treats that period as already invoiced, and the store is never billed
   * again — silently, forever, for the one seller whose invoice happened to
   * coincide with a Xendit outage. Re-emitting them makes the retry the same code
   * path as the first attempt, which is the only version of a retry that gets
   * exercised.
   */
  for v_row in
    select i.*, t.name as tenant_name, t.slug as tenant_slug,
           coalesce(r.brand_name, r.name) as reseller_name
    from public.subscription_invoices i
      join public.tenants t on t.id = i.tenant_id
      left join public.resellers r on r.id = t.reseller_id
    where i.status = 'open'
      and i.xendit_invoice_id is null
      and i.attempts < 10
    order by i.created_at
    limit p_limit
    for update of i skip locked
  loop
    v_out := v_out || jsonb_build_object(
      'invoiceId', v_row.id,
      'tenantId', v_row.tenant_id,
      'tenantName', v_row.tenant_name,
      'tenantSlug', v_row.tenant_slug,
      'amountCentavos', v_row.amount_centavos,
      'platformCutCentavos', v_row.platform_cut_centavos,
      'billedBy', v_row.reseller_name,
      'periodStart', v_row.period_start,
      'periodEnd', v_row.period_end,
      'retry', true);
  end loop;

  return v_out;
end;
$$;

/**
 * A gateway call that did not get as far as an invoice.
 *
 * Deliberately does *not* set the invoice to `failed`: `failed` means Xendit told
 * us the seller's payment did not go through, and that starts the dunning clock.
 * "We could not reach Xendit" is our problem, not the seller's, and putting a
 * store into `past_due` for our own outage is how a seller gets an email about a
 * card that never declined.
 */
create or replace function public.billing_invoice_note_failure(
  p_invoice_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.subscription_invoices
     set attempts = attempts + 1, last_error = left(p_error, 500)
   where id = p_invoice_id and status = 'open';
end;
$$;

/** Record the hosted invoice the worker created at Xendit. */
create or replace function public.billing_invoice_attach(
  p_invoice_id uuid,
  p_external_id text,
  p_checkout_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.subscription_invoices
     set xendit_invoice_id = p_external_id,
         checkout_url = p_checkout_url,
         attempts = attempts + 1
   where id = p_invoice_id;
end;
$$;

/**
 * Apply a billing callback. Idempotent by construction.
 *
 * Keyed on `xendit_invoice_id`, which is unique — so a redelivered callback finds
 * a row that is already in the state it is trying to set and returns `false`
 * without touching the subscription. Xendit retries; that is not an edge case.
 *
 * On success the period rolls forward from where it ended, not from `now()`. A
 * payment that lands three days late must not silently shorten the month the
 * seller paid for.
 */
create or replace function public.billing_invoice_settle(
  p_external_id text,
  p_status      text,
  p_paid_at     timestamptz default null,
  p_error       text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.subscription_invoices;
  v_sub public.subscriptions;
  v_months int;
begin
  if p_status not in ('paid', 'failed', 'void') then
    raise exception 'Unknown invoice status "%"', p_status using errcode = 'check_violation';
  end if;

  select * into v_invoice from public.subscription_invoices
  where xendit_invoice_id = p_external_id for update;
  if v_invoice.id is null then return false; end if;
  if v_invoice.status = p_status then return false; end if;
  if v_invoice.status = 'paid' then return false; end if;

  select * into v_sub from public.subscriptions where id = v_invoice.subscription_id for update;
  select interval_months into v_months from public.plans where id = v_sub.plan_id;

  update public.subscription_invoices
     set status = p_status,
         paid_at   = case when p_status = 'paid' then coalesce(p_paid_at, now()) end,
         failed_at = case when p_status = 'failed' then now() end,
         last_error = p_error
   where id = v_invoice.id;

  if p_status = 'paid' then
    update public.subscriptions
       set status = case when cancel_at is not null and cancel_at <= now()
                         then 'cancelled' else 'active' end,
           current_period_start = v_invoice.period_start,
           current_period_end = v_invoice.period_start
             + make_interval(months => coalesce(v_months, 1)),
           trial_ends_at = null,
           grace_ends_at = null
     where id = v_sub.id;
  elsif p_status = 'failed' then
    -- Grace, not a switch-off. Three days is long enough to notice an email and
    -- move a card, and short enough that a store that has genuinely walked away
    -- does not sit billable forever.
    update public.subscriptions
       set status = 'past_due',
           grace_ends_at = coalesce(grace_ends_at, now() + interval '3 days')
     where id = v_sub.id;
  end if;

  return true;
end;
$$;

/**
 * The clock: everything that happens because time passed rather than because
 * somebody did something.
 *
 * One function rather than three so the transitions cannot interleave — a
 * subscription that is simultaneously "trial ended" and "cancel date reached"
 * must resolve once, not race two workers to a different answer each.
 */
create or replace function public.billing_dunning_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restricted int;
  v_cancelled  int;
  v_trial_out  int;
begin
  -- Grace expired. The seller keeps the storefront, loses the ability to add.
  with moved as (
    update public.subscriptions
       set status = 'restricted'
     where status = 'past_due'
       and grace_ends_at is not null
       and grace_ends_at <= now()
    returning 1)
  select count(*) into v_restricted from moved;

  -- They asked to leave, and the period they paid for has run out.
  with moved as (
    update public.subscriptions
       set status = 'cancelled', cancelled_at = now()
     where cancel_at is not null and cancel_at <= now() and cancelled_at is null
    returning 1)
  select count(*) into v_cancelled from moved;

  -- A trial that ran out on a free plan is simply an active free store. A trial
  -- that ran out on a paid one is picked up by `billing_due_claim` on its next
  -- pass, which raises the first real invoice.
  with moved as (
    update public.subscriptions
       set status = 'active'
     where status = 'trialing'
       and trial_ends_at is not null and trial_ends_at <= now()
       and price_centavos = 0
    returning 1)
  select count(*) into v_trial_out from moved;

  return jsonb_build_object('restricted', v_restricted, 'cancelled', v_cancelled,
                            'trialsEnded', v_trial_out);
end;
$$;

-- ---------------------------------------------------------------------------
-- SMS credits, bought outright
-- ---------------------------------------------------------------------------
/**
 * What a pack costs.
 *
 * A function and not a table because these are three prices that change roughly
 * never, and a table would need a policy, a grant and a screen. The packs are
 * fixed on purpose: an arbitrary "how many credits do you want" box invites a
 * seller to buy 37 credits and then wonder why it cost more per message.
 */
create or replace function public.credit_pack_price(p_credits int)
returns bigint
language sql
immutable
as $$
  select case p_credits
           when 500   then 25000::bigint
           when 2000  then 90000::bigint
           when 10000 then 400000::bigint
         end;
$$;

/**
 * Start a credit purchase. Returns the row the worker takes to Xendit.
 *
 * The credits are **not** granted here. They are granted in
 * `credit_purchase_settle` when the money arrives, because a top-up recorded on
 * intent is a top-up a seller gets by opening a checkout page and closing it.
 */
create or replace function public.credit_purchase_start(p_tenant_id uuid, p_credits int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount bigint := public.credit_pack_price(p_credits);
  v_row public.credit_purchases;
begin
  if not public.has_tenant_role(p_tenant_id, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_amount is null then
    raise exception 'Unknown credit pack' using errcode = 'check_violation', hint = 'unknown_pack';
  end if;

  insert into public.credit_purchases (tenant_id, credits, amount_centavos)
  values (p_tenant_id, p_credits, v_amount)
  returning * into v_row;

  return jsonb_build_object('purchaseId', v_row.id, 'credits', v_row.credits,
                            'amountCentavos', v_row.amount_centavos);
end;
$$;

/** Record the hosted invoice for a credit pack. Service role only. */
create or replace function public.credit_purchase_attach(
  p_purchase_id uuid,
  p_external_id text,
  p_checkout_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.credit_purchases
     set xendit_invoice_id = p_external_id, checkout_url = p_checkout_url
   where id = p_purchase_id;
end;
$$;

/**
 * Money arrived; grant the credits. Idempotent on the provider's own id.
 *
 * `sms_credit_move` is the only thing that writes the ledger, here as everywhere
 * else — the balance is a projection of that ledger and a top-up written any
 * other way is a balance that stops reconciling.
 */
create or replace function public.credit_purchase_settle(
  p_external_id text,
  p_status      text,
  p_paid_at     timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.credit_purchases;
begin
  if p_status not in ('paid', 'failed', 'void') then
    raise exception 'Unknown purchase status "%"', p_status using errcode = 'check_violation';
  end if;

  select * into v_row from public.credit_purchases
  where xendit_invoice_id = p_external_id for update;
  if v_row.id is null or v_row.status = 'paid' or v_row.status = p_status then
    return false;
  end if;

  update public.credit_purchases
     set status = p_status,
         paid_at = case when p_status = 'paid' then coalesce(p_paid_at, now()) end
   where id = v_row.id;

  if p_status = 'paid' then
    perform public.sms_credit_move(v_row.tenant_id, v_row.credits, 'topup', null,
                                   'Credit pack ' || v_row.credits::text);
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Super admin
-- ---------------------------------------------------------------------------
/**
 * The platform's own numbers.
 *
 * MRR is normalised to a month — an annual plan contributes a twelfth — because
 * the number's only use is comparison against last month, and a metric that jumps
 * whenever somebody buys a year up front cannot be compared to anything.
 *
 * Churn is stores cancelled in the last 30 days over stores that were paying at
 * the start of it. Stated as a rate and as both of its terms: "4%" from a base of
 * twelve stores is a sentence about one seller, and a dashboard that hides the
 * denominator is a dashboard that invites a decision from noise.
 */
create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base int;
  v_lost int;
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_base from public.subscriptions
  where price_centavos > 0
    and (cancelled_at is null or cancelled_at > now() - interval '30 days')
    and created_at <= now() - interval '30 days';

  select count(*) into v_lost from public.subscriptions
  where cancelled_at is not null and cancelled_at > now() - interval '30 days';

  return jsonb_build_object(
    'mrrCentavos', coalesce((
      select sum(s.price_centavos / greatest(p.interval_months, 1))
      from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.status in ('active', 'past_due')), 0),
    'stores', jsonb_build_object(
      'total', (select count(*) from public.tenants),
      'trialing', (select count(*) from public.subscriptions where status = 'trialing'),
      'active', (select count(*) from public.subscriptions where status = 'active'),
      'pastDue', (select count(*) from public.subscriptions where status = 'past_due'),
      'restricted', (select count(*) from public.subscriptions where status = 'restricted'),
      'cancelled', (select count(*) from public.subscriptions where status = 'cancelled'),
      'new30d', (select count(*) from public.tenants where created_at > now() - interval '30 days')),
    'churn', jsonb_build_object('base', v_base, 'lost', v_lost,
      'rate', case when v_base > 0 then round((v_lost::numeric / v_base) * 100, 1) end),
    'collected30dCentavos', coalesce((
      select sum(amount_centavos) from public.subscription_invoices
      where status = 'paid' and paid_at > now() - interval '30 days'), 0),
    'overdueCentavos', coalesce((
      select sum(amount_centavos) from public.subscription_invoices
      where status in ('open', 'failed') and period_start <= now()), 0),
    'resellers', (select count(*) from public.resellers where status = 'active'),
    'resellerStores', (select count(*) from public.tenants where reseller_id is not null)
  );
end;
$$;

/** Every store, with the numbers a support conversation actually needs. */
create or replace function public.platform_tenants(
  p_search text default null,
  p_status text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(row order by row->>'createdAt' desc) from (
      select jsonb_build_object(
        'tenantId', t.id, 'name', t.name, 'slug', t.slug,
        'createdAt', t.created_at,
        'status', s.status,
        'planName', p.name,
        'priceCentavos', s.price_centavos,
        'currentPeriodEnd', s.current_period_end,
        'reseller', r.name,
        'orders', (select count(*) from public.orders o where o.tenant_id = t.id),
        'products', (select count(*) from public.products pr where pr.tenant_id = t.id),
        'users', (select count(*) from public.tenant_members m where m.tenant_id = t.id)
      ) as row
      from public.tenants t
        left join public.subscriptions s on s.tenant_id = t.id
        left join public.plans p on p.id = s.plan_id
        left join public.resellers r on r.id = t.reseller_id
      where (v_q is null or t.name ilike '%' || v_q || '%' or t.slug ilike '%' || v_q || '%')
        and (p_status is null or s.status = p_status)
      order by t.created_at desc
      limit greatest(p_limit, 0) offset greatest(p_offset, 0)) q), '[]'::jsonb);
end;
$$;

/**
 * Manual plan override.
 *
 * The escape hatch every billing system needs and every billing system regrets
 * having left unlogged: a support person moving a store onto a plan or lifting a
 * restriction is exactly the action somebody will later need to explain. The note
 * is required and it lands in the impersonation log, which is the one table in
 * this schema the *seller* can read.
 */
create or replace function public.platform_set_plan(
  p_tenant_id uuid,
  p_plan_id   uuid,
  p_status    text default null,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans;
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 8 then
    raise exception 'A reason is required' using errcode = 'check_violation', hint = 'reason_required';
  end if;

  select * into v_plan from public.plans where id = p_plan_id;
  if v_plan.id is null then
    raise exception 'No such plan' using errcode = 'no_data_found';
  end if;

  update public.subscriptions
     set plan_id = v_plan.id,
         price_centavos = v_plan.price_centavos,
         status = coalesce(p_status, status),
         grace_ends_at = case when coalesce(p_status, status) = 'active' then null
                              else grace_ends_at end,
         cancelled_at = case when coalesce(p_status, status) = 'cancelled'
                             then coalesce(cancelled_at, now()) end
   where tenant_id = p_tenant_id;

  insert into public.impersonation_sessions
    (tenant_id, actor_id, reason, actor_kind, ended_at)
  values (p_tenant_id, auth.uid(), 'Plan override: ' || btrim(p_note), 'platform', now());

  return public.subscription_overview(p_tenant_id);
end;
$$;

/** The impersonation log, platform-wide. */
create or replace function public.platform_impersonation_log(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'tenantId', s.tenant_id, 'tenantName', t.name,
             'actorEmail', u.email, 'reason', s.reason, 'actorKind', s.actor_kind,
             'startedAt', s.started_at, 'endedAt', s.ended_at, 'expiresAt', s.expires_at)
           order by s.started_at desc)
    from (select * from public.impersonation_sessions
          order by started_at desc limit greatest(p_limit, 0)) s
      join public.tenants t on t.id = s.tenant_id
      left join auth.users u on u.id = s.actor_id), '[]'::jsonb);
end;
$$;

/** Post a banner. `p_reseller_id` null is Selld talking to everybody. */
create or replace function public.platform_announce(
  p_title text,
  p_body  text,
  p_level text default 'info',
  p_ends_at timestamptz default null,
  p_reseller_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_reseller_id is null then
    if not public.is_platform_admin() then
      raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
  elsif not public.is_platform_admin()
        and not exists (select 1 from public.reseller_members m
                        where m.reseller_id = p_reseller_id and m.user_id = auth.uid()
                          and m.role in ('owner', 'admin')) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.announcements (reseller_id, title, body, level, ends_at, created_by)
  values (p_reseller_id, btrim(p_title), btrim(p_body), p_level, p_ends_at, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * The banners a store should see right now.
 *
 * Selld's, plus its own reseller's. Never another reseller's — which is not a
 * policy here so much as a consequence of the only two ways a row can be
 * addressed.
 */
create or replace function public.announcements_active(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reseller uuid;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  select reseller_id into v_reseller from public.tenants where id = p_tenant_id;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'title', a.title, 'body', a.body, 'level', a.level,
             'startsAt', a.starts_at)
           order by case a.level when 'critical' then 0 when 'warning' then 1 else 2 end,
                    a.starts_at desc)
    from public.announcements a
    where a.is_active
      and a.starts_at <= now()
      and (a.ends_at is null or a.ends_at > now())
      and (a.reseller_id is null or a.reseller_id = v_reseller)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- White label: the reseller's own console
-- ---------------------------------------------------------------------------
/** Selld onboards a reseller. The one step in this phase that is ours. */
create or replace function public.platform_create_reseller(
  p_name text,
  p_slug text,
  p_owner_email text,
  p_commission_bps int default 2000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.resellers;
  v_user uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  insert into public.resellers (name, slug, contact_email, commission_bps, brand_name)
  values (btrim(p_name), lower(btrim(p_slug)), lower(btrim(p_owner_email)),
          p_commission_bps, btrim(p_name))
  returning * into v_res;

  -- The address lives on `auth.users`; `profiles` deliberately does not carry a
  -- copy, so there is one place an email can be true.
  select id into v_user from auth.users where lower(email) = lower(btrim(p_owner_email));
  if v_user is not null then
    insert into public.reseller_members (reseller_id, user_id, role)
    values (v_res.id, v_user, 'owner')
    on conflict do nothing;
  end if;

  return jsonb_build_object('resellerId', v_res.id, 'slug', v_res.slug,
                            'ownerLinked', v_user is not null);
end;
$$;

/** Which reseller this caller may act for, at the given role. */
create or replace function public.reseller_require(p_role text default 'admin')
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select m.reseller_id into v_id
  from public.reseller_members m
    join public.resellers r on r.id = m.reseller_id
  where m.user_id = auth.uid()
    and r.status = 'active'
    and case p_role
          when 'owner' then m.role = 'owner'
          when 'admin' then m.role in ('owner', 'admin')
          else true
        end
  limit 1;

  if v_id is null then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return v_id;
end;
$$;

/**
 * A reseller's own plan.
 *
 * Their code namespace is their own — `unique nulls not distinct (reseller_id,
 * code)` — so a reseller calling their plan `starter` does not collide with ours,
 * and cannot shadow ours either.
 *
 * `limits` is taken as given rather than merged, and then clamped to Selld's top
 * plan. A reseller must be able to price and package freely — that is what they
 * are buying — and must not be able to hand a sub-tenant *more* than Selld sells
 * anybody, which is what an unclamped `{"maxProducts": 999999}` would do.
 *
 * Today Selld's top plan is unlimited, so the clamp changes nothing: reselling
 * unlimited is reselling exactly what we sell. It is written anyway, and tested
 * against a numeric ceiling, because the day `scale` grows a number is the day
 * this becomes load-bearing — and a guard added retroactively to a table full of
 * existing reseller plans is a migration nobody wants to write.
 *
 * A `null` in the request means "whatever the ceiling is", not "unlimited": a key
 * the reseller simply did not send must not be the most generous possible answer.
 */
create or replace function public.reseller_plan_upsert(
  p_code text,
  p_name text,
  p_price_centavos bigint,
  p_limits jsonb,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res uuid := public.reseller_require('admin');
  v_ceiling jsonb;
  v_limits jsonb;
  v_plan public.plans;
  v_key text;
begin
  if p_price_centavos < 0 then
    raise exception 'A price cannot be negative' using errcode = 'check_violation';
  end if;

  select limits into v_ceiling from public.plans
  where reseller_id is null and code = 'scale';

  v_limits := coalesce(p_limits, '{}'::jsonb);
  -- Clamp each numeric limit to the top Selld plan. `null` in the ceiling is
  -- unlimited, so nothing to clamp against; `null` in the request would otherwise
  -- be a reseller granting themselves unlimited.
  foreach v_key in array array['maxProducts', 'maxUsers', 'maxOrdersPerMonth'] loop
    if (v_ceiling ->> v_key) is not null then
      v_limits := jsonb_set(v_limits, array[v_key], to_jsonb(least(
        coalesce((v_limits ->> v_key)::int, (v_ceiling ->> v_key)::int),
        (v_ceiling ->> v_key)::int)));
    end if;
  end loop;

  insert into public.plans (reseller_id, code, name, description, price_centavos, limits)
  values (v_res, lower(btrim(p_code)), btrim(p_name), p_description,
          p_price_centavos, v_limits)
  on conflict (reseller_id, code) do update
    set name = excluded.name,
        description = excluded.description,
        price_centavos = excluded.price_centavos,
        limits = excluded.limits
  returning * into v_plan;

  return jsonb_build_object('planId', v_plan.id, 'code', v_plan.code,
                            'priceCentavos', v_plan.price_centavos,
                            'limits', v_plan.limits);
end;
$$;

/**
 * The done-when, in one function.
 *
 * "A reseller can onboard and bill their own seller without you touching
 * anything." Everything that would have needed a human at Selld happens here, in
 * one transaction: the store exists, it belongs to this reseller, it is on this
 * reseller's plan at this reseller's price, and the seller has an invitation to
 * take ownership of it.
 *
 * The invitation token is returned. That is deliberate and it is the one place in
 * the schema a token comes back out of a function — `invitations.token` has no
 * read policy precisely because anyone holding it can accept. The reseller is not
 * "anyone": they created this store a microsecond ago and are the only party who
 * can deliver the link to the seller. Requiring Selld to email it instead is the
 * exact step this phase exists to remove.
 */
create or replace function public.reseller_create_tenant(
  p_name text,
  p_slug text,
  p_owner_email text,
  p_plan_id uuid,
  p_price_centavos bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res    uuid := public.reseller_require('admin');
  v_slug   text := lower(btrim(p_slug));
  v_email  text := lower(btrim(p_owner_email));
  v_tenant public.tenants;
  v_plan   public.plans;
  v_token  text;
  v_price  bigint;
begin
  if not public.is_valid_tenant_slug(v_slug) or public.is_reserved_tenant_slug(v_slug) then
    raise exception 'Store address "%" cannot be used', v_slug
      using errcode = 'check_violation', hint = 'invalid_slug';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'That email address is not valid'
      using errcode = 'check_violation', hint = 'invalid_email';
  end if;

  select * into v_plan from public.plans
  where id = p_plan_id and reseller_id = v_res and is_active;
  if v_plan.id is null then
    raise exception 'That plan is not yours to sell'
      using errcode = 'insufficient_privilege', hint = 'plan_not_yours';
  end if;
  v_price := coalesce(p_price_centavos, v_plan.price_centavos);
  if v_price < 0 then
    raise exception 'A price cannot be negative' using errcode = 'check_violation';
  end if;

  insert into public.tenants (name, slug, reseller_id)
  values (btrim(p_name), v_slug, v_res)
  returning * into v_tenant;

  -- The bootstrap trigger has already written a Growth trial. Overwrite it with
  -- what the reseller actually sold, rather than skipping the trigger: the row
  -- must exist for every store at every instant, including this one.
  update public.subscriptions
     set plan_id = v_plan.id,
         price_centavos = v_price,
         status = 'trialing',
         trial_ends_at = now() + interval '14 days',
         current_period_start = now(),
         current_period_end = now() + interval '14 days'
   where tenant_id = v_tenant.id;

  insert into public.invitations (tenant_id, email, role, expires_at)
  values (v_tenant.id, v_email, 'owner', now() + interval '30 days')
  returning token into v_token;

  return jsonb_build_object(
    'tenantId', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name,
    'planName', v_plan.name, 'priceCentavos', v_price,
    'ownerEmail', v_email, 'invitationToken', v_token);
end;
$$;

/**
 * Re-price one seller. A reseller's own commercial decision, per store.
 *
 * Builds its own answer rather than returning `subscription_overview()`, and that
 * is not a style choice. The overview checks membership too, so delegating to it
 * would put a second guard behind the first — and a second guard that *also*
 * rolls the write back is a guard that makes the real one untestable: deleting
 * the ownership check above changes no observable behaviour, so the assertion
 * guarding it passes against a function that no longer has it. Two guards for one
 * rule, exactly as `marketplace_map_listing` learned in phase 17.
 */
create or replace function public.reseller_set_price(p_tenant_id uuid, p_price_centavos bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res uuid := public.reseller_require('admin');
  v_sub public.subscriptions;
begin
  if not exists (select 1 from public.tenants
                 where id = p_tenant_id and reseller_id = v_res) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_price_centavos < 0 then
    raise exception 'A price cannot be negative' using errcode = 'check_violation';
  end if;

  update public.subscriptions set price_centavos = p_price_centavos
   where tenant_id = p_tenant_id
  returning * into v_sub;

  return jsonb_build_object('tenantId', p_tenant_id, 'priceCentavos', v_sub.price_centavos,
                            'status', v_sub.status);
end;
$$;

/** The reseller's own dashboard: their sellers and what they are worth. */
create or replace function public.reseller_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res uuid := public.reseller_require('support');
  v_row public.resellers;
begin
  select * into v_row from public.resellers where id = v_res;

  return jsonb_build_object(
    'reseller', jsonb_build_object(
      'id', v_row.id, 'name', v_row.name, 'slug', v_row.slug,
      'brandName', v_row.brand_name, 'brandColor', v_row.brand_color,
      'supportEmail', v_row.support_email, 'commissionBps', v_row.commission_bps),
    'mrrCentavos', coalesce((
      select sum(s.price_centavos / greatest(p.interval_months, 1))
      from public.subscriptions s
        join public.plans p on p.id = s.plan_id
        join public.tenants t on t.id = s.tenant_id
      where t.reseller_id = v_res and s.status in ('active', 'past_due')), 0),
    'sellers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', t.id, 'name', t.name, 'slug', t.slug,
               'status', s.status, 'planName', p.name,
               'priceCentavos', s.price_centavos,
               'currentPeriodEnd', s.current_period_end,
               'orders', (select count(*) from public.orders o where o.tenant_id = t.id),
               'createdAt', t.created_at)
             order by t.created_at desc)
      from public.tenants t
        left join public.subscriptions s on s.tenant_id = t.id
        left join public.plans p on p.id = s.plan_id
      where t.reseller_id = v_res), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'code', p.code, 'name', p.name,
               'priceCentavos', p.price_centavos, 'limits', p.limits,
               'sellers', (select count(*) from public.subscriptions s2 where s2.plan_id = p.id))
             order by p.price_centavos)
      from public.plans p where p.reseller_id = v_res), '[]'::jsonb));
end;
$$;

/**
 * Revenue split, over a window.
 *
 * Reported from *paid* invoices only — the same rule phase 15 chose for lifetime
 * value and phase 18 for profit. An issued invoice is not revenue, and a
 * partner-facing number that counts one is a number that has to be walked back.
 *
 * `platform_cut_centavos` is read off each invoice rather than recomputed from the
 * commission rate, so a rate change today does not rewrite what was owed in March.
 */
create or replace function public.reseller_revenue_split(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res  uuid := public.reseller_require('support');
  v_from date := coalesce(p_from, date_trunc('month', (now() at time zone 'Asia/Manila'))::date);
  v_to   date := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_n    int;
  v_gross bigint; v_cut bigint;
  v_months jsonb;
begin
  select count(*), coalesce(sum(i.amount_centavos), 0),
         coalesce(sum(i.platform_cut_centavos), 0)
    into v_n, v_gross, v_cut
  from public.subscription_invoices i
    join public.tenants t on t.id = i.tenant_id
  where t.reseller_id = v_res and i.status = 'paid'
    and (i.paid_at at time zone 'Asia/Manila')::date between v_from and v_to;

  select coalesce(jsonb_agg(jsonb_build_object(
           'month', m.month,
           'grossCentavos', m.gross,
           'platformCutCentavos', m.cut,
           'netCentavos', m.gross - m.cut) order by m.month), '[]'::jsonb)
    into v_months
  from (
    select to_char(date_trunc('month', i.paid_at at time zone 'Asia/Manila'), 'YYYY-MM') as month,
           sum(i.amount_centavos) as gross,
           sum(i.platform_cut_centavos) as cut
    from public.subscription_invoices i
      join public.tenants t on t.id = i.tenant_id
    where t.reseller_id = v_res and i.status = 'paid'
      and (i.paid_at at time zone 'Asia/Manila')::date between v_from and v_to
    group by 1) m;

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'invoices', v_n,
    'grossCentavos', v_gross,
    'platformCutCentavos', v_cut,
    'netCentavos', v_gross - v_cut,
    'byMonth', v_months);
end;
$$;

/** Branding for the dashboard shell. Null when the store is Selld's own. */
create or replace function public.reseller_branding(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.resellers;
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  select r.* into v_row from public.resellers r
    join public.tenants t on t.reseller_id = r.id
  where t.id = p_tenant_id and r.status = 'active';
  if v_row.id is null then return null; end if;

  return jsonb_build_object(
    'name', coalesce(v_row.brand_name, v_row.name),
    'color', v_row.brand_color,
    'logoPath', v_row.logo_path,
    'supportEmail', v_row.support_email);
end;
$$;

/** The reseller edits its own brand. */
create or replace function public.reseller_set_branding(
  p_brand_name text default null,
  p_brand_color text default null,
  p_logo_path text default null,
  p_support_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res uuid := public.reseller_require('admin');
begin
  update public.resellers
     set brand_name = coalesce(nullif(btrim(p_brand_name), ''), brand_name),
         brand_color = coalesce(nullif(btrim(p_brand_color), ''), brand_color),
         logo_path = coalesce(nullif(btrim(p_logo_path), ''), logo_path),
         support_email = coalesce(nullif(btrim(p_support_email), ''), support_email)
   where id = v_res;
  return public.reseller_overview();
end;
$$;

/** Am I platform staff, a reseller, or neither? One call for the app shell. */
create or replace function public.my_platform_roles()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'isPlatformAdmin', public.is_platform_admin(),
    'platformRole', (select role from public.platform_admins where user_id = auth.uid()),
    'reseller', (
      select jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug,
                                'role', m.role,
                                'brandName', coalesce(r.brand_name, r.name))
      from public.reseller_members m join public.resellers r on r.id = m.reseller_id
      where m.user_id = auth.uid() and r.status = 'active'
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end
      limit 1));
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Read-only for every client role, on every table in this file. There is no
-- `insert`, `update` or `delete` grant below and that is not an oversight: a
-- seller who can update `subscriptions` can set their own status to `active`, and
-- a seller who can insert into `platform_admins` is a platform admin.
grant select on public.plans                  to authenticated;
grant select on public.resellers              to authenticated;
grant select on public.reseller_members       to authenticated;
grant select on public.impersonation_sessions to authenticated;
grant select on public.subscriptions          to authenticated;
grant select on public.subscription_invoices  to authenticated;
grant select on public.credit_purchases       to authenticated;
grant select on public.announcements          to authenticated;
-- `platform_admins` gets nothing. Not even select.

-- Every function below starts from `revoke all ... from public`, because Postgres
-- grants EXECUTE to PUBLIC on creation and `revoke ... from anon, authenticated`
-- does not take back a privilege held *through* PUBLIC — it succeeds, changes
-- nothing, and reports no error. `record_payment_event` shipped anon-callable
-- exactly that way in phase 8. And because that revoke also takes it from
-- `service_role` (which has BYPASSRLS but is not a superuser and still needs
-- grants), every service-role function is granted back explicitly below.

revoke all on function public.plan_limit(uuid, text) from public;
revoke all on function public.plan_has_feature(uuid, text) from public;
revoke all on function public.billing_allows_writes(uuid) from public;
revoke all on function public.enforce_product_limit() from public;
revoke all on function public.enforce_seat_limit() from public;
revoke all on function public.enforce_order_limit() from public;
revoke all on function public.enforce_feature_gate() from public;
revoke all on function public.bootstrap_subscription() from public;
revoke all on function public.impersonation_guard() from public;

-- Boundary predicates. Readable by anyone signed in — they answer only about the
-- caller, and the app shell needs them before it can decide what to render.
revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_reseller_of(uuid) from public;
revoke all on function public.current_reseller() from public;
revoke all on function public.is_impersonating(uuid) from public;
revoke all on function public.plan_is_visible(uuid) from public;
revoke all on function public.reseller_is_visible(uuid) from public;
revoke all on function public.reseller_require(text) from public;
revoke all on function public.my_platform_roles() from public;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_reseller_of(uuid) to authenticated;
grant execute on function public.current_reseller() to authenticated;
grant execute on function public.is_impersonating(uuid) to authenticated;
grant execute on function public.plan_is_visible(uuid) to authenticated;
grant execute on function public.reseller_is_visible(uuid) to authenticated;
grant execute on function public.my_platform_roles() to authenticated;

-- Impersonation. `impersonate_begin` is service role only: the *server* decides
-- that a request is an impersonation, on the strength of a session it
-- authenticated itself. A client that could call it could name its own actor id.
revoke all on function public.impersonate_begin(uuid, uuid, text) from public;
revoke all on function public.impersonate_end(uuid) from public;
grant execute on function public.impersonate_begin(uuid, uuid, text) to service_role;
grant execute on function public.impersonate_end(uuid) to service_role, authenticated;

-- What a seller does on their own billing screen.
revoke all on function public.subscription_overview(uuid) from public;
revoke all on function public.subscription_plans(uuid) from public;
revoke all on function public.subscription_change_plan(uuid, uuid) from public;
revoke all on function public.subscription_cancel(uuid) from public;
revoke all on function public.subscription_resume(uuid) from public;
revoke all on function public.credit_purchase_start(uuid, int) from public;
revoke all on function public.credit_pack_price(int) from public;
revoke all on function public.announcements_active(uuid) from public;
revoke all on function public.reseller_branding(uuid) from public;
grant execute on function public.subscription_overview(uuid) to authenticated;
grant execute on function public.subscription_plans(uuid) to authenticated;
grant execute on function public.subscription_change_plan(uuid, uuid) to authenticated;
grant execute on function public.subscription_cancel(uuid) to authenticated;
grant execute on function public.subscription_resume(uuid) to authenticated;
grant execute on function public.credit_purchase_start(uuid, int) to authenticated;
grant execute on function public.credit_pack_price(int) to authenticated;
grant execute on function public.announcements_active(uuid) to authenticated;
grant execute on function public.reseller_branding(uuid) to authenticated;

-- The billing worker. Money moves here, so nothing but the server touches it.
revoke all on function public.billing_due_claim(int) from public;
revoke all on function public.billing_invoice_attach(uuid, text, text) from public;
revoke all on function public.billing_invoice_note_failure(uuid, text) from public;
revoke all on function public.billing_invoice_settle(text, text, timestamptz, text) from public;
revoke all on function public.billing_dunning_run() from public;
revoke all on function public.credit_purchase_attach(uuid, text, text) from public;
revoke all on function public.credit_purchase_settle(text, text, timestamptz) from public;
grant execute on function public.billing_due_claim(int) to service_role;
grant execute on function public.billing_invoice_attach(uuid, text, text) to service_role;
grant execute on function public.billing_invoice_note_failure(uuid, text) to service_role;
grant execute on function public.billing_invoice_settle(text, text, timestamptz, text) to service_role;
grant execute on function public.billing_dunning_run() to service_role;
grant execute on function public.credit_purchase_attach(uuid, text, text) to service_role;
grant execute on function public.credit_purchase_settle(text, text, timestamptz) to service_role;

-- Super admin. Each checks `is_platform_admin()` itself — the grant to
-- `authenticated` is not the boundary, it is only what makes the call reachable.
revoke all on function public.platform_overview() from public;
revoke all on function public.platform_tenants(text, text, int, int) from public;
revoke all on function public.platform_set_plan(uuid, uuid, text, text) from public;
revoke all on function public.platform_impersonation_log(int) from public;
revoke all on function public.platform_announce(text, text, text, timestamptz, uuid) from public;
revoke all on function public.platform_create_reseller(text, text, text, int) from public;
grant execute on function public.platform_overview() to authenticated;
grant execute on function public.platform_tenants(text, text, int, int) to authenticated;
grant execute on function public.platform_set_plan(uuid, uuid, text, text) to authenticated;
grant execute on function public.platform_impersonation_log(int) to authenticated;
grant execute on function public.platform_announce(text, text, text, timestamptz, uuid) to authenticated;
grant execute on function public.platform_create_reseller(text, text, text, int) to authenticated;

-- The reseller console.
revoke all on function public.reseller_plan_upsert(text, text, bigint, jsonb, text) from public;
revoke all on function public.reseller_create_tenant(text, text, text, uuid, bigint) from public;
revoke all on function public.reseller_set_price(uuid, bigint) from public;
revoke all on function public.reseller_overview() from public;
revoke all on function public.reseller_revenue_split(date, date) from public;
revoke all on function public.reseller_set_branding(text, text, text, text) from public;
grant execute on function public.reseller_plan_upsert(text, text, bigint, jsonb, text) to authenticated;
grant execute on function public.reseller_create_tenant(text, text, text, uuid, bigint) to authenticated;
grant execute on function public.reseller_set_price(uuid, bigint) to authenticated;
grant execute on function public.reseller_overview() to authenticated;
grant execute on function public.reseller_revenue_split(date, date) to authenticated;
grant execute on function public.reseller_set_branding(text, text, text, text) to authenticated;

comment on table public.platform_admins is
  'Selld staff. RLS on, no policy, no client grants: this table holds authority, not a secret, and a table that grants its own membership is a privilege-escalation path.';
comment on table public.impersonation_sessions is
  'Audit trail for support acting as a seller. Append-only; the access is derived from the row, so it cannot be taken without leaving one. The seller can read their own store''s rows.';
comment on function public.enforce_order_limit() is
  'Monthly order ceiling, applied to manually created orders only. A buyer''s checkout must never fail because of the seller''s billing status.';
