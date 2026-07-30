# Selld — working notes for Claude Code

Multi-tenant ecommerce + order operations platform for Philippine social sellers.
Build one phase per session, in order. The full roadmap is in
[`docs/build-spec.md`](docs/build-spec.md); who we're building for is in
[`docs/avatar.md`](docs/avatar.md).

**Current state: phase 0 complete.** Next up is phase 1 (auth & multi-tenant core).

---

## Commands

```bash
pnpm install          # pnpm, not npm — see "Package manager" below
pnpm dev              # dev server on :5173
pnpm verify           # typecheck + lint + test + build — run before every commit
pnpm test:watch       # tests in watch mode

pnpm db:start         # Supabase local stack (needs Docker)
pnpm db:reset         # reset + re-run migrations, then reseed PSGC
pnpm db:new <name>    # scaffold a migration
pnpm db:types         # regenerate src/lib/supabase/database.types.ts — after EVERY migration

pnpm psgc:build       # refetch PSGC from the PSA mirror (only when PSA publishes an update)
pnpm psgc:seed        # load supabase/seed/psgc.json.gz into the database
```

## Hard rules — these are not negotiable

1. **Every tenant-scoped table has `tenant_id uuid not null` and RLS enabled.** No
   exceptions. Reference tables (PSGC) are the only tables without a `tenant_id`,
   and they still have RLS with an explicit read-only policy.
2. **All money is integer centavos.** Use `src/lib/money` — never a float, never
   `parseFloat`, never `toFixed` arithmetic. The `public.centavos` Postgres domain
   documents this at the schema level.
3. **All timestamps are `timestamptz` stored UTC, displayed `Asia/Manila`.** Use
   `src/lib/time/manila`. "Today's orders" must group by Manila day, not UTC day.
4. **Mobile-first.** The dashboard must be fully usable at a 390px viewport.
   Minimum touch target 44px. Sellers work from phones.
5. **Every user-facing string goes through i18n** with `en` and `tl` locales.
   `tl` is **Taglish**, not deep Tagalog — keep the loanwords sellers actually say
   ("orders", "inventory", "dashboard"). Deep-Tagalog UI reads as machine
   translation and costs credibility.
6. **Never trust client-side prices.** Recompute every cart total server-side at
   checkout.
7. **Every external API call is wrapped in an idempotency key + retry with
   exponential backoff, and logged to `integration_logs`.** Use
   `src/core/integration`.

## Architecture

```
src/
  core/         ← extraction boundary; becomes @yourorg/ph-commerce-core
    couriers/ payments/ sms/ marketplaces/ tenancy/ integration/
  app/          ← dashboard (authenticated seller surface)
  storefront/   ← public buyer surface, own perf budget
  features/     ← feature slices; may import from core and lib
  lib/          ← money, phone, psgc, i18n, time, supabase, tenant
  components/ui ← shadcn/ui primitives
```

**Dependency direction points inward.** `src/core` must not import from `app`,
`storefront`, or `features`, and must contain no React. See
[`src/core/README.md`](src/core/README.md). Adding a fifth courier should touch
one new file plus one registry line, and zero lines of order logic.

## Things that will bite you

- **`forwardRef` is mandatory on any UI primitive used with Radix `asChild`.**
  This project is pinned to React 18, where `ref` is not a plain prop. Current
  shadcn/ui source omits `forwardRef` because it targets React 19 — copying it
  verbatim silently breaks every dropdown, tooltip, and dialog trigger: the popper
  never measures its anchor and renders off-screen at `translate(0, -200%)`.
  jsdom does not catch this (no layout). `src/components/ui/button.test.tsx`
  guards it; check new primitives in a real browser.
- **`erasableSyntaxOnly` is on.** No constructor parameter properties, no enums.
- **PSGC has no province for NCR.** 19 cities (the 16 NCR cities/municipality plus
  independent cities like Isabela City) have `province_code IS NULL`. The address
  cascade must support region → city directly. Use `listCities()` in
  `src/lib/psgc/queries.ts`, which encapsulates this.
- **PSGC city names are inconsistent** — "City of Davao" but "Quezon City". Use
  `display_name` ("Davao City") in UI and for shipping-zone matching; `name` is
  the canonical PSA value kept for integrity.
- **Manila barangays carry both `city_code` and `sub_municipality_code`** (the 14
  districts: Tondo, Sampaloc, …). Buyers write the district, not "City of Manila".
- **`react-hooks` v7 lint rules are strict.** No `setState` in an effect body —
  drive state from the event instead. `useState` (not `useMemo`) for anything that
  must be referentially stable, like the QueryClient.

## Package manager

pnpm, pinned via `packageManager`. `pnpm-lock.yaml` is the source of truth and CI
installs with `--frozen-lockfile`. `npm install` will resolve a different tree and
ignore the lockfile — don't. (Script names are the same either way, so
`npm run build` works if you already installed with pnpm.)

## Conventions

- Migrations are append-only once pushed. Before that, editing in place is fine.
- Regenerate `database.types.ts` after every migration or the client types lie.
- New provider implementations register at app startup, never at import time, so
  tests can install fakes.
- Tests live beside the code (`*.test.ts`). Prefer testing the behaviour that
  would break a seller's day over line coverage.
