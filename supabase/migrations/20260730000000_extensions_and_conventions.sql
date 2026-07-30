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
