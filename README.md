# Selld

**The online store built for Filipino social sellers — no commission, ever.**

Multi-tenant ecommerce + order operations platform for Philippine social sellers.
Working name: **Selld** (`selld.ph` / `selld.store`).

> **Status: phase 15 (Customers & CRM) complete.** Next: phase 16, broadcasts, vouchers & abandoned cart.
> See [`docs/phase-status.md`](docs/phase-status.md).

---

## Quick start

Requires **Node ≥ 20.19**, **pnpm 10**, and **Docker** (for the local database).

```bash
pnpm install
cp .env.example .env.local

pnpm db:start          # Supabase local stack; prints your anon key
# paste VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY into .env.local
pnpm db:reset          # apply migrations + seed PSGC reference data

pnpm dev               # dashboard  -> http://localhost:5173

pnpm seed:demo         # a demo store with product images
pnpm dev:store         # storefront -> http://rheas-finds.localhost:5174
```

The dashboard renders without Supabase credentials, so `pnpm dev` works before you
set anything up — only features that query the database need `.env.local`.

**The two surfaces are served differently.** The dashboard is a client-rendered
SPA behind auth. The storefront is **server-rendered** by a small Node server,
because it carries an LCP < 2.0 s on 3G budget that a client-rendered page cannot
meet: HTML, then JS, then boot, then a data fetch is four sequential round trips
before anything paints.

**Storefronts resolve by hostname.** `*.localhost` subdomains resolve to
127.0.0.1 in every modern browser, so `http://rheas-finds.localhost:5174` exercises
the real subdomain path in dev.

### Before every commit

```bash
pnpm verify            # typecheck + lint + test + build
pnpm db:test           # RLS isolation suite — needs a running database
```

`verify` deliberately excludes `db:test`, which requires Postgres. CI runs both.

Note: `pnpm db:test` assumes it owns the database — it asserts absolute row counts.
It clears and repopulates inside a transaction it rolls back, so running it after
`pnpm seed:demo` is safe and leaves your demo store intact.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dashboard dev server (Vite) on :5173 |
| `pnpm dev:store` | Storefront SSR server on :5174 |
| `pnpm build` | Client bundle + SSR renderer (`dist/client`, `dist/server`) |
| `pnpm start` | Production storefront server — needs `pnpm build` first |
| `pnpm seed:demo` | Demo store + generated product images, for storefront work |
| `pnpm lighthouse` | Lighthouse mobile against a running `pnpm start` |
| `pnpm verify` | Typecheck, lint, test, build — the full gate |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm db:start` / `db:stop` | Supabase local stack |
| `pnpm db:reset` | Re-run migrations, then reseed PSGC |
| `pnpm db:new <name>` | Scaffold a migration |
| `pnpm db:types` | Regenerate `database.types.ts` — after **every** migration |
| `pnpm db:test` | Run `supabase/tests/*.sql` — the RLS isolation suite |
| `pnpm db:test:concurrency` | Oversell prevention, with real parallel connections |
| `pnpm psgc:build` | Refetch PSGC from the PSA mirror (only when PSA publishes an update) |
| `pnpm psgc:seed` | Load `supabase/seed/psgc.json.gz` into the database |

## Architecture

```
src/
  core/          ← extraction boundary → @yourorg/ph-commerce-core (shared with Servd)
    couriers/    payments/  sms/  marketplaces/  tenancy/  integration/
  app/           ← dashboard (authenticated seller surface)
  storefront/    ← public buyer surface, separate perf budget
  features/      ← feature slices
    address/  auth/  catalog/  inventory/  onboarding/  tenancy/
  lib/           ← money, phone, psgc, i18n, time, supabase, tenant
  components/ui  ← shadcn/ui primitives
supabase/
  migrations/    ← append-only once pushed
  seed/          ← PSGC reference data (committed, 380 KB gzipped)
  templates/     ← auth emails (must render {{ .Token }} — see CLAUDE.md)
  tests/         ← SQL suites; the RLS isolation proof lives here
scripts/         ← PSGC pipeline + SQL test runner
```

The dashboard and storefront are **lazy-loaded as separate chunks**, so a buyer on
`{slug}.selld.ph` never downloads auth, tenancy, or the dashboard shell (88 KB
gzipped vs 190 KB).

Dependencies point inward: `src/core` imports nothing from `app`, `storefront`, or
`features`, and contains no React. See [`src/core/README.md`](src/core/README.md).

## The parts worth knowing about

**Money is integer centavos, always.** [`src/lib/money`](src/lib/money/centavos.ts)
brands the type so "did I already convert this?" is a compile-time question. It
rounds half-away-from-zero and includes `allocate()` (largest remainder) so
prorating a discount across line items can never lose or invent a centavo.

**Phone numbers are the customer identity** in PH social commerce — sellers have a
name and a number, rarely an email. [`src/lib/phone`](src/lib/phone/ph-phone.ts)
normalises every input form to `+63` E.164 exactly once, and distinguishes mobile
from landline because only mobiles can receive SMS.

**PSGC addresses go four levels deep** — region, province, city/municipality,
barangay — with 42,046 barangays, because couriers price and route on barangay and
a PH address without one is not deliverable. Two structural quirks are handled in
[`src/lib/psgc`](src/lib/psgc/queries.ts): NCR has no provinces (19 cities have
`province_code IS NULL`), and PSA city naming is inconsistent ("City of Davao" but
"Quezon City"), so a normalised `display_name` exists for UI and rate matching.

**Time is UTC in, Manila out.** [`src/lib/time/manila`](src/lib/time/manila.ts)
exists because "today's orders" and the daily COD cutoff must be Manila days — a
naive UTC date splits one Manila morning across two buckets.

**Tenant isolation is enforced in the database, not the client.** Every
tenant-scoped policy funnels through `is_tenant_member(tenant_id)`, and
[`supabase/tests/tenancy-isolation.sql`](supabase/tests/tenancy-isolation.sql)
proves cross-tenant reads and writes return nothing — 556 assertions, run in CI on
every PR. The suite is verified by sabotage: break RLS and it fails. Read the
"Writing a tenant-scoped table" section of [`CLAUDE.md`](CLAUDE.md) before adding
a table.

**Stock cannot be oversold, and the number is always explainable.** The movement
ledger is the source of truth and `on_hand` is a trigger-maintained cache, so
`sum(delta) = on_hand` holds by construction. Overselling is blocked by two
independent layers — sorted advisory locks in `reserve_stock()` and a
`reserved <= on_hand` CHECK constraint — and
[`scripts/db-concurrency-test.ts`](scripts/db-concurrency-test.ts) proves each one
separately with real parallel connections.

**Providers are interfaces first.** Adding a fifth courier should touch one new
file and one registry line, and zero lines of order logic.

**Facebook's 24-hour messaging window is enforced in the database.** A page may
send a standard message only within 24 hours of the person's last message, and
misusing a message tag to get around that costs the page its ability to message
anyone. So `message_send_allowed()` is the single decision point, every path asks
before it sends rather than after, and
[`supabase/tests/tenancy-isolation.sql`](supabase/tests/tenancy-isolation.sql)
drives all six ways it can say no.

## Documentation

| Doc | What's in it |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Working notes: hard rules, conventions, and the traps |
| [`docs/build-spec.md`](docs/build-spec.md) | The 21-phase build spec and 64-table schema |
| [`docs/phase-status.md`](docs/phase-status.md) | What's shipped, what's next |
| [`docs/avatar.md`](docs/avatar.md) | Rhea — the one person we build for |
| [`docs/value-equation.md`](docs/value-equation.md) | Hormozi value equation applied |
| [`docs/offer.md`](docs/offer.md) | The Commission Escape Plan — pricing, bonuses, guarantee |
| [`docs/hooks-and-ads.md`](docs/hooks-and-ads.md) | Hook bank, content pillars, qualifying flow |
| [`docs/go-to-market.md`](docs/go-to-market.md) | Launch sequence |
| [`docs/moat.md`](docs/moat.md) | Why this is defensible |

## The one thing to remember

We don't compete on features. We compete on:

> **Gawa ito para sa'yo, at hindi ka kinakaltasan.**

Hyper-local operational reality plus a flat fee. If a feature doesn't serve the
avatar in [`docs/avatar.md`](docs/avatar.md), it doesn't ship.
