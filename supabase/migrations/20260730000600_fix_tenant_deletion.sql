-- Fix: guard triggers were blocking legitimate DELETE cascades.
--
-- Two separate triggers had the same flaw. Both were written to protect against a
-- deliberate act and both also fired on the cascade from deleting a parent, so a
-- tenant could never be deleted at all.
--
-- The general lesson, recorded in CLAUDE.md: a guard trigger on a child table must
-- distinguish "someone is editing this row" from "the parent is going away and this
-- is its cascade". The parent's absence is the reliable signal, because the parent
-- row is already gone by the time the child trigger fires.
--
-- ---------------------------------------------------------------------------
-- 1. prevent_last_owner_removal
-- ---------------------------------------------------------------------------
-- `prevent_last_owner_removal()` (phase 1) refuses to let the last owner's
-- membership go, which is right for a deliberate demotion or "leave store". But
-- deleting a tenant CASCADES into tenant_members, and that cascade removes the
-- owner — so the trigger fired and blocked it. Every `delete from tenants` failed
-- with "A tenant must keep at least one owner", which also made phase 1's
-- "Owners delete their tenant" RLS policy dead code.
--
-- Phase 1's tests asserted that the last owner cannot be demoted or removed. They
-- never asked whether a tenant can be deleted at all, so the bug shipped green.
--
-- The fix distinguishes the two cases by checking whether the tenant still exists.
-- On a cascade from `delete from tenants`, the parent row is already gone by the
-- time the trigger fires on the child, so its absence is a reliable signal that the
-- whole tenant is going rather than one owner being removed from a live store.

create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := coalesce(old.tenant_id, new.tenant_id);
  v_owners    int;
begin
  -- The tenant itself is being deleted; this is its cascade, not a demotion.
  if not exists (select 1 from public.tenants t where t.id = v_tenant_id) then
    return coalesce(new, old);
  end if;

  -- Only relevant when an accepted owner stops being one.
  if old.role <> 'owner' or old.accepted_at is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.accepted_at is not null then
    return new;
  end if;

  select count(*) into v_owners
  from public.tenant_members m
  where m.tenant_id = v_tenant_id
    and m.role = 'owner'
    and m.accepted_at is not null
    and m.id <> old.id;

  if v_owners = 0 then
    raise exception
      'A tenant must keep at least one owner. Promote another member, or delete the store instead.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.prevent_last_owner_removal() is
  'Blocks removing a tenant''s last owner, while allowing the cascade from deleting the tenant itself.';

-- NOTE for phase 20 (Data Privacy Act deletion requests): deleting an auth user
-- still fails while they are the sole owner of a live tenant, because the tenant
-- survives that cascade and would be orphaned. The deletion flow must delete or
-- transfer the seller's stores first. That is deliberate — silently orphaning a
-- store with live orders would be worse than an explicit refusal.


-- ---------------------------------------------------------------------------
-- 2. reject_ledger_mutation
-- ---------------------------------------------------------------------------
-- Same flaw: the ledger is append-only, so the trigger refused every DELETE —
-- including the cascade from removing a variant, a product, or a whole tenant. The
-- concurrency test caught it in teardown, trying to delete its own fixture.
--
-- Editing history is still refused. Deleting a movement whose variant is already
-- gone is not editing history; it is the history going away with its subject.
create or replace function public.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.product_variants v where v.id = old.variant_id)
  then
    -- Cascade from deleting the variant/product/tenant.
    return old;
  end if;

  raise exception
    'stock_movements is append-only. Write a compensating movement instead of editing history.'
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.reject_ledger_mutation() is
  'Keeps the stock ledger append-only, while allowing the cascade from deleting a variant or tenant.';
