-- Phase 0 — extensions and shared conventions.
--
-- Kept separate from any table definitions so it stays the first migration
-- forever and later migrations can rely on these primitives existing.

-- Trigram search. Needed to typeahead 42,046 barangays at checkout without a
-- full table scan on every keystroke.
create extension if not exists pg_trgm with schema extensions;

-- Used from phase 8 onward to encrypt courier / marketplace credentials at rest.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Default privileges: a grant nobody wrote is still a grant
-- ---------------------------------------------------------------------------
-- Supabase's Postgres image ships with
--
--   alter default privileges in schema public
--     grant all on tables/sequences/functions to anon, authenticated, service_role;
--
-- so *every* table and function these migrations create is handed to `anon` and
-- `authenticated` in full, at CREATE time, before the migration's own narrow
-- grant runs. That silently defeats three things this schema is built on:
--
--   * Column-list grants. RLS is row-level, so the column list is the only way
--     to say "a member may read this table but not this column". A table-level
--     grant from the defaults overrides it, and `payment_accounts.secret_key`,
--     `payment_accounts.callback_token`, `courier_accounts.credentials_encrypted`
--     and `carts.token` all become readable.
--   * `revoke all on function … from public`. Postgres grants EXECUTE on a new
--     function to PUBLIC, which is why that revoke exists — but the defaults
--     grant EXECUTE to `anon` *directly*, and a revoke from PUBLIC does not
--     take back a privilege a role holds in its own right. Every service_role-only
--     function became anon-callable: `record_payment_event`, which marks orders
--     paid; `impersonate_begin`; `broadcast_claim_next`; `live_ingest_comment`.
--   * Tables that are never granted out at all, because the absence of a grant
--     *is* the control — the stock ledger's append-only rule among them.
--
-- It has to be undone here rather than in a later migration: the privilege is
-- attached when the object is created, so anything after the fact would have to
-- revoke everything and then restate all ~160 grants from the other 24 files,
-- which is the sort of duplicate that drifts. Three lines at the top instead,
-- and every later migration's grant becomes the whole truth about that object.
--
-- `service_role` is deliberately left alone. It is not a client role — it is the
-- key our own Node server holds, it already has BYPASSRLS, and it reads tables
-- directly (`courier_accounts.credentials_encrypted` among them) on paths no
-- migration grants it explicitly. Phase 8's `revoke … from public` broke the
-- payment webhook for a whole phase exactly this way; narrowing the two roles a
-- browser can actually hold is the boundary that matters.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest
-- ---------------------------------------------------------------------------
-- Every mutable table gets a `before update` trigger using this. Setting
-- updated_at in application code is unreliable — bulk updates and SQL run from
-- the dashboard bypass it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger function: sets updated_at to now() on UPDATE. Attach as a BEFORE UPDATE trigger.';

-- ---------------------------------------------------------------------------
-- Money domain
-- ---------------------------------------------------------------------------
-- All money is an integer count of centavos, never a float. This domain makes
-- that a schema-level guarantee rather than a code review habit, and gives
-- column definitions a self-documenting type.
create domain public.centavos as bigint;

comment on domain public.centavos is
  'PHP amount in centavos (integer). ₱1,499.00 is stored as 149900. Never use numeric/float for money.';
