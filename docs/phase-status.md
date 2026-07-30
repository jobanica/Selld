# Phase status

One phase per session, in order. See [`build-spec.md`](build-spec.md) for each
phase's scope and done-when criteria.

| Phase | Name | Status |
|---:|---|---|
| 0 | Foundation | ✅ Complete |
| 1 | Auth & multi-tenant core | ✅ Complete |
| 2 | Store onboarding wizard | ⬜ Next |
| 3 | Catalog | ⬜ |
| 4 | Inventory | ⬜ |
| 5 | Storefront | ⬜ |
| 6 | Cart & guest checkout | ⬜ |
| 7 | Shipping configuration | ⬜ |
| 8 | Payments | ⬜ |
| 9 | Order management dashboard | ⬜ |
| 10 | Courier integration | ⬜ |
| 11 | Tracking & buyer notifications | ⬜ |
| 12 | COD reconciliation & RTS control | ⬜ |
| 13 | Live selling capture | ⬜ |
| 14 | Messenger & social integration | ⬜ |
| 15 | Customers & CRM | ⬜ |
| 16 | Broadcasts, vouchers & abandoned cart | ⬜ |
| 17 | Marketplace sync | ⬜ |
| 18 | Analytics & true profit | ⬜ |
| 19 | Billing, super admin & white-label | ⬜ |
| 20 | Hardening & launch | ⬜ |

Phases 0–9 are a complete sellable product. MVP for first paying customers is
0 → 11.

---

## Phase 1 — Auth & multi-tenant core ✅

**Done-when criterion**

> Two tenants exist and neither can read a single row of the other's data — prove
> it with SQL tests.

✅ Proven by [`supabase/tests/tenancy-isolation.sql`](../supabase/tests/tenancy-isolation.sql):
**79 assertions**, run in CI on every PR via `pnpm db:test`.

The suite was itself verified by sabotage — disabling RLS on `tenants`, and
separately making `is_tenant_member()` return `true` unconditionally, each make it
fail with `psql` exit code 3. An isolation test that cannot detect broken isolation
is worthless, so this check matters as much as the tests.

What it proves, with two sellers (Rhea, Marlon), a packer, and a user with no
tenant at all:

- Cross-tenant `SELECT` returns zero rows — by id, by slug, and summed across all
  four tables at once
- Cross-tenant `UPDATE`/`DELETE` affect zero rows; cross-tenant `INSERT` raises
- A user with no membership sees zero tenants and only their own profile
- Teammates can read each other's profiles; non-teammates cannot
- An invitation token is never readable through RLS, cannot be redeemed by a
  different email, cannot be redeemed twice, and expires
- Roles are enforced: a packer cannot rename the tenant, invite, add members, or
  self-promote; an admin cannot invite at owner level
- A tenant can never lose its last owner
- A spoofed `x-selld-tenant` header falls back to the caller's own tenant
- `anon` has no privilege on any base table, but can read the public storefront
  projection — which is asserted to expose only branding columns, and to drop
  suspended stores

**Delivered**

- Four tables — `tenants`, `profiles`, `tenant_members`, `invitations` — with RLS
  and `FORCE ROW LEVEL SECURITY` on all four
- RLS helpers: `is_tenant_member()`, `tenant_role_of()`, `has_tenant_role()`,
  `current_tenant_id()`, plus `tenant_role_rank()` for "at least this role" checks
- RPCs: `create_tenant()` (tenant + owner membership atomically),
  `accept_invitation()`, `my_tenants()`
- Auth trigger creating a profile per user, normalising `639…` to `+639…`
- Last-owner protection trigger
- `storefront_tenants` — a minimal public projection for anonymous
  `{slug}.selld.ph` resolution
- OTP sign-in (SMS or email, 6-digit code), tenant switcher, account menu,
  create-store page, invitation acceptance at `/invite/:token`
- Dashboard and storefront split into separate lazy chunks
- CI additions: `pnpm db:test`, plus a check that `database.types.ts` matches the
  migrations

**Verified**

- 143 unit tests; 79 SQL assertions
- Sign-in verified in Chromium at 390px and 1280px, both locales, zero console
  errors, no horizontal overflow. Landline input is rejected client-side **before**
  an SMS credit is spent.
- Storefront payload cut from 190 KB to **88 KB gzipped** by the code split

**Deferred, deliberately**

- **Phone OTP delivery is not wired to Semaphore.** Supabase has no native
  Semaphore provider, so live SMS needs a Send-SMS auth hook (an Edge Function).
  The client path is complete and tested; the hook lands with the `SmsProvider`
  implementation in phase 11, which is the first phase that needs Semaphore
  credentials anyway. **Email OTP works today; phone OTP will not deliver until
  then.**
- Invitation **emails** are not sent — `inviteMember()` creates the row, and the
  link must be shared manually for now. Phase 2 owns the team-management UI.
- No end-to-end auth run against a live Supabase stack (see the phase 0 note on
  the container's disk budget). The RLS layer is proven against real Postgres; the
  OTP round trip is covered by unit tests with the client stubbed.

---

## Phase 0 — Foundation ✅

**Done-when criteria**

| Criterion | Status |
|---|---|
| `pnpm build` passes | ✅ 389 KB JS / 22 KB CSS, 0 type errors, 0 lint errors |
| Empty dashboard shell renders | ✅ Verified in Chromium at 390px and 1280px, zero console errors |
| Locale toggle works | ✅ en ⇄ tl through the real UI, persisted to `localStorage` |

**Delivered**

- Vite 8 + React 18 + TS 5.9 + Tailwind 4 + shadcn/ui + TanStack Query + React Router 7
- Folder structure with `src/core/` as the Servd extraction boundary
  (open decision #1 resolved)
- i18n with `en` / `tl` (Taglish), typed so a missing translation is a compile error
- `src/lib/money` — integer centavos, largest-remainder `allocate()`, half-away-from-zero
  rounding, bigint-safe arithmetic
- `src/lib/phone` — PH normalisation to `+63` E.164, mobile vs landline, SMS eligibility
- `src/lib/time/manila` — Manila-day grouping so daily cutoffs are correct
- PSGC reference data: 17 regions, 81 provinces, 1,634 cities, 42,046 barangays
  (migration + validated fetch/seed pipeline, 380 KB gzipped seed committed)
- Provider interfaces for couriers, payments, SMS, marketplaces + retry/backoff,
  idempotency keys, error taxonomy, generic registry
- CI: typecheck, lint, test, build **plus** migrations applied to a clean
  `supabase/postgres` and PSGC row counts asserted
- 118 tests

**Verified against a real database** (`supabase/postgres:15.8.1.060`): both
migrations apply to an empty schema, seeder loads 42,046 barangays and is
idempotent on re-run, trigram barangay search runs in 0.6 ms, `anon` can read
PSGC and cannot write it.

**Notable finding:** `Button` initially did not forward its ref. Every unit test
passed — jsdom does no layout — but in a real browser it broke every Radix
`asChild` trigger (popper rendered off-screen at `translate(0, -200%)`). Fixed
with `forwardRef` and guarded by a test that was confirmed to fail when the bug is
reintroduced. This is a React-18-specific hazard; see `CLAUDE.md`.

**Deferred to phase 1**, deliberately:

- `supabase start` full local stack was not exercised (validated against the
  Postgres image directly instead, to stay inside the container's disk budget)
- `src/features/*` is an empty convention — first slice lands with auth
- `database.types.ts` currently describes only the PSGC tables
