# Phase status

One phase per session, in order. See [`build-spec.md`](build-spec.md) for each
phase's scope and done-when criteria.

| Phase | Name | Status |
|---:|---|---|
| 0 | Foundation | ✅ Complete |
| 1 | Auth & multi-tenant core | ✅ Complete |
| 2 | Store onboarding wizard | ✅ Complete |
| 3 | Catalog | ✅ Complete |
| 4 | Inventory | ✅ Complete |
| 5 | Storefront | ✅ Complete |
| 6 | Cart & guest checkout | ✅ Complete |
| 7 | Shipping configuration | ✅ Complete |
| 8 | Payments | ✅ Complete |
| 9 | Order management dashboard | ✅ Complete |
| 10 | Courier integration | ✅ Complete |
| 11 | Tracking & buyer notifications | ⬜ Next |
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

## Phase 4 — Inventory ✅

**Done-when criterion**

> Two concurrent checkouts for the last unit — exactly one succeeds. Oversell
> prevention as a Postgres constraint + advisory lock, not application logic.

✅ Proven by [`scripts/db-concurrency-test.ts`](../scripts/db-concurrency-test.ts):
**23 assertions across 5 scenarios, using real parallel connections.** This cannot
live in the SQL suite — a single psql session runs statements in order, so it can
simulate a race but never reproduce one.

```
=== 1. Two checkouts, one unit, race held open
  ok  client A reserved the last unit
  ok  client B blocked on the advisory lock instead of reading stale stock
  ok  client B failed once A committed
  ok  client B got a business error ("Insufficient stock"), not a constraint violation
  ok  exactly one unit ended up reserved (= 1)
  ok  on_hand is untouched — a reservation is not a movement (= 1)

=== 2. 20 simultaneous buyers, 5 units
  ok  exactly 5 buyers won (= 5)
  ok  the other 15 were told stock ran out (= 15)
  ok  nobody hit an unexpected error — every loss was a clean business error (= 0)

=== 3. Opposing multi-variant carts (deadlock avoidance)
  ok  no deadlock — locks are acquired in sorted order

=== 5. Raw UPDATEs with no lock — the CHECK constraint alone
  ok  refused by the inventory_no_oversell CHECK — the constraint, not the lock
```

**Each layer is verified independently.** Sabotage runs showed the two defences are
caught by *different* tests, which is worth knowing:

| Sabotage | Caught by |
|---|---|
| Remove the advisory lock | Scenario 3 (deadlock detected) |
| Remove the `reserved <= on_hand` CHECK | Scenario 5, and the SQL suite |

Scenario 5 exists because of that finding. Without it, deleting the constraint left
scenarios 1–3 green — the lock alone serialises reservations, so the constraint never
fires — which made "the constraint protects us even if a future code path forgets the
lock" an untested claim. Scenario 5 bypasses `reserve_stock()` with raw UPDATEs and
tests exactly that.

**The design decision**

The movement ledger is the source of truth; `inventory_levels.on_hand` is a cache
maintained by trigger. The alternative — update the count and separately write a
history row — drifts, and a seller who cannot reconcile "I have 7" against "here is
why" stops trusting the number and then stops using the feature. So `on_hand` is
never written directly (a guard trigger refuses), the ledger is append-only, and
`sum(delta) = on_hand` holds by construction. Both suites assert it.

Reservations are deliberately **not** movements: reserving changes no physical stock,
so it touches `reserved` only. `available = on_hand − reserved`, and the UI leads
with available rather than on hand — on hand is what is in the room, available is
what a buyer can actually buy, and showing the wrong one is how a seller oversells
while looking at a screen that says she has stock.

**Delivered**

- `inventory_levels` and `stock_movements`, both tenant-scoped with RLS
- Reserve / release / ship / adjust / stock-take RPCs, all holding sorted advisory
  locks
- Stock adjustment UI with reason codes, in two modes (relative "received 50",
  absolute "I counted 5" — the latter still writes the difference as a movement)
- The per-variant movement ledger, shown **inside** the adjustment sheet rather than
  on a separate screen: a seller adjusting stock is almost always reconciling, and
  the history that answers her question belongs where she asks it
- Low-stock thresholds, a dashboard-ready count, and a filter
- `storefront_availability` — `in_stock` plus a coarse bucket, with exact counts
  withheld by design (a count tells a competitor the seller's volume)
- Isolation suite extended to inventory: **157 assertions**

**Two bugs found, both the same shape**

`prevent_last_owner_removal` (phase 1) and `reject_ledger_mutation` (this phase) were
both written to block a deliberate act, and both also fired on the DELETE cascade
from removing a parent. Between them, **a tenant could never be deleted** — which
also made phase 1's "Owners delete their tenant" RLS policy dead code. Phase 1's
tests asserted the last owner cannot be demoted or removed; they never asked whether
a tenant can be deleted at all, so it shipped green. Fixed in
`20260730000600_fix_tenant_deletion.sql`, with the lesson recorded in `CLAUDE.md`.

**A CI flake found and fixed.** `pg_isready` returns true before the Postgres image
finishes installing extension files, so applying migrations immediately after the
health check can fail on a missing `pg_trgm`. It bit locally; in CI it would have
been an intermittent failure under load. The workflow now gates on a query that
proves the instance is actually usable.

**Deferred, deliberately**

- **`stock_transfers` / `stock_transfer_items` are not built.** The build spec
  itself flags them as trimmable from v1, and multi-location transfers are only
  meaningful once a seller has more than one location — which the Scale tier
  introduces in phase 19. The `transfer` reason code exists so the ledger can
  already record one.
- `incoming` is stored and displayed but nothing writes it yet; purchase orders are
  not in the 21-phase plan.
- `saveProduct()` is still a sequence of PostgREST calls rather than one RPC. I said
  in phase 3 that phase 4 would move it — it turned out not to be load-bearing,
  because `inventory_levels` rows are created lazily by the first movement rather
  than at product creation, so a partial product save leaves no inventory
  inconsistency. Moving it now would be churn for its own sake; phase 6 revisits it
  when checkout genuinely needs multi-table atomicity.

---

## Phase 3 — Catalog ✅

**Done-when criterion**

> A 3-option product with 12 variants can be created on a phone in under 2 minutes.

✅ Driven end to end in a real Chromium at **390px** against the full local Supabase
stack:

```
[0.3s] name, price, weight entered
[0.8s] three options entered  (Size: S,M,L · Color: Black,White · Sleeve: Short,Long)
[1.0s] matrix generated -> "12 variants generated"
[3.5s] bulk price + SKUs applied to all 12
[5.1s] SAVED AND PUBLISHED
=== 5.1s     console errors: none     no horizontal overflow
```

Verified in the database afterwards: 12 variants, 12 distinct SKUs, ₱549 on every
row, and the combinations ordered `S/Black/Short … L/White/Long` — the last option
varying fastest, so rows group by size the way a rack does.

What actually buys the 2 minutes is not the generator but the two bulk actions.
Twelve rows × three fields is 36 entries; "apply this price to all" plus
"auto-fill SKUs" turns the common case (one price across a size run) into two.

**Delivered**

- Seven tables: `categories`, `products`, `product_options`,
  `product_option_values`, `product_variants`, `product_images`, `media_assets` —
  every one with `tenant_id` and RLS, per hard rule 1
- **Composite foreign keys** so denormalised `tenant_id` cannot disagree with its
  parent: each parent has `unique (tenant_id, id)` and each child references
  `(tenant_id, parent_id)`. A cross-tenant child is unrepresentable rather than
  merely forbidden
- Variant integrity enforced in the database, not the form: exactly one value per
  option, values must belong to *this* product, no duplicate combination (order
  independent — the array is normalised by trigger), compare-at must exceed price,
  SKU unique per tenant
- `generateVariantMatrix()` — cartesian product that **keeps prices and SKUs for
  combinations that survive a regeneration**, so adding one colour does not blank
  twelve prices
- `diffVariants()` — so saving never deletes and recreates an untouched variant,
  which would silently discard the stock phase 4 attaches to it
- Hand-written CSV import/export: quoted fields, embedded commas, `""` escapes,
  CRLF, Excel's BOM. Reports per-row errors **and imports the rest** — one bad row
  must not cost a seller the other 200. Export → edit → re-import round-trips
- Quick-add form (comma-separated option values, so `S, M, L` is one field),
  variant grid that is a table from `sm` up and stacked cards on phones
- Categories seeded from the phase 2 onboarding presets via
  `seed_categories_from_presets()`, idempotent
- Public storefront projections (`storefront_products`, `storefront_variants`,
  `storefront_product_images`) that **exclude `cost_centavos`** — that column is
  the seller's margin
- Isolation suite extended to the catalog: **129 assertions**

**Verified by sabotage.** Disabling RLS on `product_variants` fails the suite
(`Marlon cannot see Rhea's variants — expected 0, got 4`), and adding
`cost_centavos` to the public view fails it too. Over real HTTP as `anon`:
`storefront_products` returns the published product, asking for `cost_centavos`
returns **400**, and all five base tables return **401**.

**The bug worth reading**

The variant grid's price inputs were uncontrolled (`defaultValue`). "Apply to all"
updated the state and the row badges but left every input showing the old number —
it saved the correct price and looked completely broken, which is worse than
failing, because the seller cannot tell which one to believe. Caught by reading a
screenshot, not by a test. Fixed by making the input controlled while still letting
the seller type freely (state adjusted from props *during render*, since the
`react-hooks` rules correctly forbid doing it in an effect), and guarded by
`variant-grid.test.tsx`.

**Deferred, deliberately**

- **Stock is not in the variant grid**, despite the build spec listing it in this
  phase. `inventory_levels` is per-location and arrives in phase 4; a `stock` column
  on a variant would be a second source of truth from the day it shipped. The grid
  says so inline rather than showing a dead field.
- **Product images have a schema and a bucket but no upload UI.** The tables and
  storage policies are done and tested; wiring the picker is a small piece of
  phase 5, where the storefront actually renders them.
- `saveProduct()` is a sequence of PostgREST calls, not one transaction — PostgREST
  cannot express one across requests. A failed save leaves a draft the seller can
  retry. Phase 4 moves it into an RPC, where inventory makes atomicity genuinely
  load-bearing.
- Barcode is stored but not surfaced in the grid; it belongs with the phase 9
  packing flow that scans it.

---

## Phase 2 — Store onboarding wizard ✅

**Done-when criterion**

> A new signup reaches a live (empty) storefront in under 3 minutes.

✅ Verified end to end against the **full local Supabase stack** (Postgres 17.6,
GoTrue, PostgREST, Storage, Mailpit) driving a real Chromium at 390px:

```
[1.0s] sign-in page
[1.5s] code requested
[1.5s] OTP retrieved from email: 182767
[1.8s] signed in -> create store        slug suggested: rheas-finds
[2.2s] wizard step 1 (identity)
[2.4s] wizard step 2 (branding)
[2.7s] wizard step 3 (presets)
[2.9s] wizard step 4 (shipping origin)  Davao City barangays loaded: 182
[3.4s] wizard step 5 (payments)
[3.6s] DASHBOARD REACHED
=== total elapsed: 3.7s     console errors: none
```

That 3.7s is machine time, not a claim about a human — it is the *system* cost of
the path. What it establishes is that nothing in the flow blocks, retries, or
round-trips more than it needs to, so the 3-minute budget is spent on the seller
thinking rather than on the software.

Persisted state was then checked in the database: `₱30` typed into the COD field
stored as `3000` centavos, `0917 123 4567` normalised to `+639171234567`, presets
saved as `["skincare","rtw"]`, and the origin resolved through PSGC to
`Buhangin (Pob.), Davao City, Davao Del Sur`.

**Honest scope note:** the storefront *page* is phase 5. What phase 2 delivers is
a signup that ends with a fully configured store whose subdomain resolves and
whose branding is readable anonymously — verified over real HTTP:

| Request as `anon` | Result |
|---|---|
| `storefront_tenants?slug=eq.…` | 200, returns name/slug/brand colour |
| `storefront_theme_public?slug=eq.…` | 200, returns preset/colours |
| `tenants` | **401** |
| `tenant_settings` | **401** |
| `locations` (the seller's home address) | **401** |
| `psgc_regions` | 200 (public reference data) |

**Delivered**

- Three tables: `tenant_settings` (key/value), `locations` (PSGC-coded, one
  default per tenant enforced by partial unique index), `storefront_themes`
- A trigger seeds a theme row and 9 default settings on **tenant creation**, not
  in the wizard — an abandoned wizard still leaves a coherent tenant
- Theme colours validated in the database: a non-hex value is rejected by trigger,
  not just by the form
- Public `tenant-public` storage bucket, with the tenant-id path prefix as the
  authorisation boundary
- `PhAddressPicker` — the reusable region → province → city → barangay cascade,
  which phase 6 checkout will use unchanged
- The 5-step wizard, resumable: each step saves and `onboarding.step` records
  progress
- 12 category presets written from what PH social sellers actually sell
- Client-side image downscaling before logo upload (512px max edge)
- Isolation suite extended to the new tables: **105 assertions**, and now also
  verified on Postgres 17.6 as well as the 15.8 CI image

**The finding worth reading**

Email OTP silently did not work. `signInWithOtp({ email })` sends Supabase's
default template, which is a magic **link** — so the seller received a link while
the app asked for a 6-digit **code** she never got. Nothing errored; sign-in was
simply impossible. Fixed by adding `supabase/templates/otp-code.html` (which
renders `{{ .Token }}`) and wiring it to the `magic_link`, `confirmation` and
`recovery` templates in `config.toml`.

> ⚠️ **`config.toml` is local-only.** On Supabase cloud the same three templates
> must be set under **Authentication → Emails**, or production reverts to magic
> links and email sign-in breaks again. This is a deployment checklist item, not a
> code change.

**Deferred, deliberately**

- **Xendit is not connected.** Step 5 shows online payment as an inert,
  clearly-labelled placeholder rather than a toggle that would fail at checkout.
  Phase 8 owns it. COD is fully functional.
- Phone OTP still needs the Semaphore send-SMS hook (phase 11) — unchanged from
  phase 1.
- Category presets are stored only; phase 3 creates the actual `categories` rows
  from them via `categoriesForPresets()`.
- Barangay names keep the PSA `(Pob.)` suffix — e.g. `Buhangin (Pob.)`. Left
  verbatim because courier portals show the same form, so a seller comparing the
  two sees a match.

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

---

## Phase 5 — Storefront

**Done when:** Lighthouse mobile performance ≥ 90 and the store looks legitimately
branded, not templated.

**Measured** (`pnpm lighthouse`, Lighthouse 13.4 mobile preset — Slow 4G, 1.6 Mbps,
150 ms RTT, 4× CPU, 390×844 @2×, against the production build and real Supabase
Storage):

| Page | Perf | A11y | SEO | Best practices | LCP | FCP | TBT | CLS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Home | **100** | 98 | 100 | 100 | 1.56 s | 0.65 s | 16 ms | 0.000 |
| Product | **99** | 96 | 100 | 100 | 2.20 s | 0.64 s | 19 ms | 0.000 |

The done-when is met on both pages with margin. The **LCP < 2.0 s architecture
budget is met on the home page and missed by ~0.2 s on the product page** — see
"Not met" below. `pnpm lighthouse` gates on the stated done-when and reports the
LCP budget as a warning; the threshold was deliberately not raised to 2500 ms to
make it pass, because a threshold moved to match the measurement stops being one.

### What was built

- **Server rendering.** `server/storefront-server.ts` resolves the store from the
  Host header, fetches one payload, renders React to string, and inlines critical
  CSS + the theme + the hydration payload. Brotli/gzip on the way out. The
  dashboard stays client-rendered — it is behind auth and invisible to crawlers.
- **One round trip per page.** `storefront_home()` and `storefront_product_page()`
  each return the whole page as a single jsonb document. Five sequential queries
  would have been 750 ms of pure latency at 150 ms RTT before a byte of HTML.
- **No client router, progressive enhancement.** Real links, real GET form.
  Verified with JavaScript fully disabled: search returns results, category
  filtering works, product links work.
- **Deferred hydration** to idle-after-load or first interaction, at
  `fetchpriority="low"`. Both paths verified in a real browser.
- **Theming** from `storefront_themes` / `brand_color`, with a contrast-derived
  foreground so a pale brand colour does not produce an unreadable "Add to cart".
  Seller `custom_css` is sanitised against `</style>` break-out.
- **Responsive images** with recorded renditions (`product_images.renditions`),
  matching `sizes` on the `<img>` and `imagesrcset`/`imagesizes` on the preload.
- **SEO**: per-page title/description, canonical (search canonicalises to the
  store root and is `noindex`), OG + Twitter tags, Product/Store JSON-LD with
  `Offer` vs `AggregateOffer` chosen correctly, `robots.txt`, `sitemap.xml`.
- **Demo fixture.** `pnpm seed:demo` builds "Rhea's Finds" and generates product
  images with a dependency-free PNG writer, uploaded to real Supabase Storage.

### Notable findings

Five bugs that only a real browser or a real measurement could surface:

| Symptom | Cause |
|---|---|
| Every store rendered in Selld green, correct colour present in the HTML | Theme `<style>` emitted *before* the app CSS; equal specificity on `:root` means source order wins. Fixed with `html:root` so it wins on specificity, since in dev Vite appends the app CSS at runtime and ours can never be last. |
| Production storefront completely unstyled — 200, all content present | Read `manifest[entry].css`, which is empty: Rollup attributes Tailwind's sheet to the vendor chunk shared with the dashboard. Now walks the import graph, and fails loudly if no CSS is reachable. |
| Dev: no styles, dead variant picker, "can't detect preamble" | Hand-built HTML skipped `vite.transformIndexHtml()`, so React Refresh's preamble never ran. |
| `fetchPriority` warning for every image during hydration | React 19 prop on a React 18 project. The server emits it verbatim and it works (HTML attributes are case-insensitive) while the client warns. Now passed lowercase. |
| Product LCP 3.5 s with the network almost idle | The 193 KB React vendor chunk downloaded concurrently with the LCP image. Hydration now waits for idle and requests at low priority. |

Two more found while writing the phase, in older code:

- **`_plural` i18n keys were dead** since i18next v21 — `catalog.variantCount` and
  `inventory.lowStockCount` had been rendering "3 variant" and "4 item is low on
  stock" since phases 3 and 4. Nothing warns; the lookup misses and falls back to
  the singular. Fixed to `_one`/`_other` and guarded by
  `src/lib/i18n/plurals.test.ts`. In `tl` both forms carry the same text, because
  Tagalog nouns are not inflected for number.
- **`pnpm seed:demo` broke `pnpm db:test`** — both create a `rheas-finds` tenant,
  and the isolation suite asserts absolute counts. The suite now clears the
  database inside the transaction it already rolls back.

### Sabotage findings

- Removing **only** the `tenant_id` filter from `storefront_product_page()`'s
  product lookup — leaving everything else identical — makes assertion
  "a product cannot be fetched through another store's slug" fail. Confirmed.
- The first version of that assertion **passed for the wrong reason**: an earlier
  section leaves Marlon's tenant suspended, so the call returned null because the
  *store* was unresolvable, not because the product was refused. The block now
  reactivates it first.
- `sanitizeCustomCss()`'s single-pass replace could be **bypassed by making the
  removal rebuild the terminator** (`</sty</stylele` → delete the one `</style` →
  `</style`). Now loops until stable; the bypass string is a test case.

### Not met

- **LCP 2.20 s on the product page**, against the 2.0 s budget. The LCP element is
  the full-size product photo, and the demo fixture writes **PNG** — a real upload
  pipeline emitting WebP at the same dimensions is roughly half the bytes, which
  closes the gap. That belongs in the phase 3 upload path (which does not downscale
  or transcode at all yet), not in a tuning knob here. Recorded rather than worked
  around: `content-visibility: auto` on the below-fold related row was tried and
  reverted, because it made the number non-deterministic (2.1 s / 3.5 s across runs)
  instead of better.
- **Generated OG image cards are not built.** The brief asks for "OG image
  generation per product". What ships is the fallback chain that actually drives
  Messenger and Facebook previews — real product photo, then the store logo — plus
  correct OG/Twitter tags, price and availability properties. A *generated* branded
  card would only apply to products with no photo, and rendering text into a raster
  needs a font rasteriser (`satori` + `@resvg/resvg-js`, one of them a native
  binary). Deferred deliberately rather than shipped as an SVG, because Facebook
  does not accept SVG `og:image` — and Facebook is exactly where this matters.

### Deferred

- `og:image:width`/`height` are omitted because `product_images` stores no
  dimensions, and a wrong hint makes Facebook crop to it rather than measure.
- The dashboard is still served by the Vite SPA in dev; the SSR server hands
  dashboard hostnames the SPA shell in production.
- Deployment: the storefront now needs a Node process, not just static hosting.

**Gate:** `pnpm verify` (309 tests), `pnpm db:test` (186 assertions),
`pnpm db:test:concurrency` (23 assertions), `pnpm lighthouse`. All 9 migrations
apply from scratch on PG 15.8 and 17.6.

---

## Phase 6 — Cart & guest checkout

**Done when:** a full checkout takes under 60 seconds on mobile with 5 taps of
typing or less.

**Measured** in Chromium at 390×844 @2×, throttled to 150 ms RTT / 1.6 Mbps with a
4× CPU slowdown, against the production build and a real database — from tapping
"add to cart" on a product page to the confirmation screen rendering:

| | Result | Budget |
|---|---:|---:|
| Elapsed | **34.8 s** | 60 s |
| Typed fields | **3** (name, phone, street) | ≤ 5 |
| Taps | 10 | — |
| Horizontal overflow | 0 px | 0 |
| Console errors | none | none |

Three typed fields is the genuine floor for a deliverable PH address: everything
else is a tap, and a returning buyer on the same device gets all of it prefilled.

### The security model changes shape here

Every phase before this had one boundary — `is_tenant_member(tenant_id)`. A buyer
has no account, so carts and checkout are authorised by a **cart token** (32 random
bytes, httpOnly, SameSite=Lax). `anon` gets **no table grants at all** on any phase
6 table; everything goes through `SECURITY DEFINER` functions that check the token.
`carts.token` is not selectable even by a member — a column-level grant, because RLS
is row-level and a seller holding the token could act as the buyer.

`apply_reservation()` was extracted from phase 4's `reserve_stock()` so guest
checkout could hold the same sorted advisory locks without reimplementing them.
`reserve_stock` checks membership, `checkout_place_order` checks the cart token, and
both delegate — which also means the concurrency suite still exercises the code path
the storefront uses.

### Hard rule 6, asserted rather than asserted-to

`cart_pricing()` is the single place money is computed, shared by the quote the
buyer sees and the order that gets written. The isolation suite rewrites
`cart_items.unit_price_centavos` to **1 centavo** — the strongest form of the attack
— and asserts the order still charges ₱447.00.

That assertion was **wrong at first and passed anyway**: the tamper and the check
ran on different carts, so it stayed green even with `cart_pricing` rewritten to
trust the client's snapshot. Sabotage caught it. It now stashes the token in a
fixture table, tampers with that exact cart, and fails with "expected 44700, got 3"
when the rule is broken.

### What was built

- `customers`, `carts`, `cart_items`, `orders`, `order_items`,
  `order_status_history`, `order_counters`, plus `integration_logs` and `sms_logs`
  (hard rule 7's tables — this phase makes the first outbound call).
- Order numbers from a per-tenant counter updated with `UPDATE … RETURNING`, so two
  concurrent checkouts cannot take the same number.
- `orders_total_adds_up` as a CHECK: the grand total must equal its parts, enforced
  at the schema level rather than trusted from whatever wrote the row.
- Cart via form POST + 303, so add-to-cart, quantity and remove all work before
  hydration — and the quantity stepper is two 44 px submit buttons rather than a
  number input, which on Android opens a keyboard the buyer then has to dismiss.
- One-page checkout in the brief's order (contact → address → shipping → payment →
  review). Five separate screens is five round trips on 3G against a stopwatch
  done-when; the review is permanently visible as the totals block.
- PSGC cascade with **no province step for NCR**, one server round trip per level.
  Without JavaScript the buyer taps a labelled button; once hydrated the select
  calls `requestSubmit` with that same button — the trigger is enhanced, not the
  fetch, so there is one code path.
- Confirmation SMS through `src/core/sms` with an idempotency key, retry, and a row
  in both log tables. It can never fail an order: the order is committed and the
  buyer is already looking at the receipt, so every failure is caught and logged.

### Notable findings

| Symptom | Cause |
|---|---|
| Cart silently stayed empty under `pnpm start` | `Secure` cookie keyed on `NODE_ENV` while serving plain http. Clients correctly refuse to store it, and nothing errors. Now derived from `x-forwarded-proto` / socket encryption. |
| React discarded the whole SSR tree on cart pages | `cartCount` was rendered server-side but omitted from the inlined hydration payload, so the badge `<span>` mismatched. A hydration warning here silently undoes phase 5's perf work. |
| An order accepted with a region code as its city | A JSONB address snapshot has no foreign keys, and "non-empty" is not "real". Now verified against PSGC *and* for mutual consistency. |
| Confirmation SMS cost two segments for 122 characters | `₱` is not in GSM-7, so one character forced UCS-2 and halved the budget from 160 to 70 — doubling the seller's bill on every order. Now `PHP 229.00`. |
| Place-order button greyed out with everything filled in | It was disabled from the *server's* last-known address, which a buyer who just picked a barangay has not updated. Removed — server validation is the authority, and the barangay arrives with the submit, so the order now completes in that one tap. |

### Deliberately deferred

- **Shipping is one flat rate** from a new `shipping.flat_centavos` setting
  (default ₱80). Phase 7 owns zones, weight tiers, free-over-threshold and live
  courier quotes — it replaces the resolver, not the checkout flow.
- **COD only.** `checkout_place_order` refuses every other method rather than
  creating an order that cannot be paid; Xendit is phase 8.
- **Discounts** are wired through the schema and the totals as a zero — phase 14.
- **Abandoned-cart recovery** has its columns (`carts.expires_at`, status) but no
  job; phase 11.
- **Semaphore** is not integrated. The SMS path runs on the `log` provider so it is
  a real exercised code path from now on rather than something first wired up in
  phase 11; registering Semaphore is a one-line change at startup.

**Gate:** `pnpm verify` (336 tests), `pnpm db:test` (225 assertions),
`pnpm db:test:concurrency` (23 assertions). All 11 migrations apply from scratch on
PG 17.6.

---

## Phase 7 — Shipping configuration

**Done when:** a seller can express "₱80 Davao City, ₱150 Mindanao, ₱200 rest of PH,
free over ₱2,000" without touching code.

**Measured** by typing exactly that configuration into `/shipping` in Chromium at
390×844 @2×, against a real database, and then reading it back off the page:

```
Davao City   1 area  · ₱80.00  · free over ₱2,000.00   [Davao City]
Mindanao     6 areas · ₱150.00 · free over ₱2,000.00   [Zamboanga Peninsula,
                                                        Northern Mindanao,
                                                        Davao Region, SOCCSKSARGEN,
                                                        Caraga, BARMM]
Rest of PH   FALLBACK  Covers everywhere else · ₱200.00 · free over ₱2,000.00
```

| | Result | Budget |
|---|---:|---:|
| Lines of code changed to express it | **0** | 0 |
| Horizontal overflow at 390px | 0 px | 0 |
| Touch targets under 44px (phase-7 controls) | 0 | 0 |
| Console errors | none¹ | none |

¹ One 409 is logged, from the deliberate duplicate-area attempt in step 6.

The zones are listed in **resolution order** — most specific first, catch-all last —
so the list reads as the sentence the seller was trying to write.

### What shipped

- **`shipping_zones` / `shipping_zone_areas` / `shipping_rates` /
  `shipping_weight_tiers`**, all tenant-scoped with RLS. Zones are member-readable
  and admin-writable: a packer needs to know what shipping costs to print a label,
  but deciding what it costs is a different job.
- **`resolve_shipping_zone()`** — most specific match wins: city (3) > province (2)
  > region (1) > catch-all (0), with `sort_order` only as a tiebreak between equally
  specific zones.
- **`quote_shipping()`** returns a jsonb document, not a bare amount, so checkout can
  say *which* rate applied and whether free shipping kicked in. "₱200" with no
  explanation is what makes a buyer abandon.
- **Rate types** `flat`, `weight_tiered` and `courier_live`. `free_over_centavos` is
  a modifier on whichever type is chosen rather than a fourth type — "₱200 rest of
  PH, free over ₱2,000" is one rule, and splitting it into two rates that must agree
  is how they stop agreeing.
- **Weight bands** with `up_to_grams IS NULL` as the open-ended top band, so a 40kg
  parcel is priced rather than falling off the end. A partial unique index allows
  only one open band per rate.
- **`seed_shipping_presets()`** — the Metro Manila / provincial split, which is the
  fastest path from nothing to a store that can quote anywhere in the country.
- **COD fee** computed as flat + basis points of subtotal
  (`payments.cod_fee_centavos` + `payments.cod_fee_bps`), and the **per-product COD
  block** (`products.is_cod_allowed`, a column since phase 3) now actually enforced:
  `cart_pricing` reports `codAllowed: false` when any line blocks it and
  `checkout_place_order` refuses the order, rather than the storefront merely hiding
  the option. Verified by placing a COD order containing a blocked item and watching
  it be rejected.
- **`cart_pricing()` grew an address parameter.** The cart page has no address yet,
  so it passes nulls, gets the catch-all zone's price, and labels it
  `shippingEstimated: true`. Verified end to end: the cart shows ₱200 as an estimate
  while checkout and the written order both charge the resolved ₱80.

### Deviation from the spec

The brief specified `match_rules JSONB` on a zone. Zone areas are instead rows with
real foreign keys into PSGC, one column per level plus a CHECK that the level agrees
with the populated column. The reason is phase 6's bug: a JSONB address snapshot has
no foreign keys, and "non-empty" accepted a region code posted into the city field.
The same mistake in a zone rule would not error — it would silently never match, and
the seller would find out from a buyer who was overcharged. Now a stale or bogus code
is rejected at write time, and the UI turns that into "That place is not in the PSGC
list any more."

### Notable findings

| Symptom | Cause |
|---|---|
| Every shipping write failure read "Could not save that. Please try again." | `describeShippingError` guarded on `error instanceof Error`, but PostgREST returns a **plain object** unless `.throwOnError()` is used. All eight cases fell through to the fallback, telling the seller to retry something that could never succeed. `describeStockError` had the identical bug since phase 4, hiding the oversell message during a live rush. Both now use `errorMessage()`. |
| Ten resolver assertions passed against a sabotaged resolver | The SQL fixture numbered `sort_order` 0/1/2 in specificity order, so `order by sort_order` alone gave the same answers. The fixture now numbers them backwards; deleting the specificity tiebreak fails four assertions. |
| The zone list led with the catch-all, under a heading promising resolution order | `sort_order` defaults to 0 for every zone the UI creates, so PostgREST returned them in creation order. A seller reading top-to-bottom would conclude the fallback is what applies. Now sorted by `byResolutionOrder`. |
| `cart_pricing(uuid, text)` became ambiguous at runtime | `create or replace function` with *added* defaulted parameters creates an overload rather than replacing. The migration reported success while every existing caller failed. Fixed with an explicit `drop function` first. |
| Re-applying the migration silently skipped every function | `psql -v ON_ERROR_STOP=1` aborted at "relation already exists", and a `grep -v "already exists"` filter hid it. |
| Edit/Done at 36px, remove-area X at 24px | `size="sm"` is 36px and `button-variants.ts` reserves it for dense table rows; these are one-handed controls. Now 44px. |

### Deliberately deferred

- **`courier_live` charges the rate's fallback amount** and says so on the screen.
  A real quote needs a booked courier account, which is phase 10.
- **Weight bands have no editor yet** — the schema, the resolver and the read-back
  display are all there, and `seed_shipping_presets` can write them, but adding a
  band from the UI is not wired. Flat and free-over cover the done-when sentence.
- **Zone reordering** is not exposed. `sort_order` exists and is respected; nothing
  in the UI sets it, and resolution no longer depends on it.
- **The percentage COD fee has no editor.** `payments.cod_fee_bps` is read by
  `cart_pricing` and charged correctly, but only the flat fee is editable (in the
  onboarding payments step). Phase 8 owns the payments settings screen and is where
  both belong.

### Still needed outside the repo

- The three OTP email templates (`magic_link`, `confirmation`, `recovery`) must be
  set in the Supabase **cloud** dashboard under Authentication → Emails.
  `supabase/config.toml` is local-only, and email sign-in silently breaks without
  them.
- The storefront needs a Node process, not just static hosting.

**Gate:** `pnpm verify` (349 tests), `pnpm db:test` (266 assertions),
`pnpm db:test:concurrency` (23 assertions). All 12 migrations apply from scratch on
PG 17.6.

---

## Phase 8 — Payments

**Done when:** a GCash payment moves the order to `paid` via webhook with no
polling, and replaying the same webhook twice changes nothing.

**Measured** by driving the real storefront and the real webhook endpoint over HTTP
against a real database:

```
1. Buyer places a GCash order            POST /checkout -> 303, order 0001, unpaid
2. Payment opened                        awaiting_action, ref inv_live_9001
3. Rejections come first                 no token 401 · wrong token 401
                                         unknown slug 404 · GET 405
                                         order after rejections: unpaid
4. Verified webhook                      {"outcome":"applied", ...}  order: paid
5. Replayed twice                        {"outcome":"duplicate","applied":false}
   before (events|history|payments|paid_at|status): 1|2|2|04:12:33+00|paid
   after  (events|history|payments|paid_at|status): 1|2|2|04:12:33+00|paid
```

Nothing polls. The order reaches `paid` on the delivery itself, and two replays
changed no row, no timestamp and no timeline entry.

### What shipped

- **`webhook_events`** with `unique (provider, external_id)`. `record_payment_event`
  inserts there *first* and returns early on conflict, so a duplicate cannot reach
  the order-mutating half of the function at all. Replay safety is a constraint, not
  a code path that every future edit has to remember.
- **`payments`** — one row per *attempt*, not per order. An order legitimately
  accumulates several (an expired GCash invoice, a failed one, then a bank transfer
  recorded by hand), and that history is what a seller needs when a buyer says "I
  already paid". `orders.payment_status` is *derived* from them by
  `sync_order_payment_status`, never assigned.
- **`payment_accounts`** with per-tenant Xendit credentials — the money must land in
  the seller's bank, not ours. `secret_key` and `callback_token` appear in no GRANT,
  so no client role can read them; sellers see `payment_accounts_safe`, which reports
  whether a key is set and its last four characters.
- **Webhook routing by opaque slug.** Xendit's callback token is a static per-account
  secret, so a delivery must be attributed *before* it can be verified. A tenant id in
  the URL would be printed on a settings screen and in every support screenshot; a
  32-byte random slug identifies the account and names nothing.
- **`XenditProvider`** implementing the phase-0 `PaymentProvider` interface: invoices
  covering GCash, Maya, GrabPay, QRPH and cards behind one hosted page, which also
  keeps card details out of this codebase entirely (PCI scope stays SAQ-A). Every
  call carries a deterministic idempotency key, retries with backoff, and is logged
  to `integration_logs` — hard rule 7, verified against a real 401 from `api.xendit.co`.
- **Online checkout**, offered only when the store has a working enabled account.
  Phase 6's blanket "COD only" refusal became a real capability check.
- **COD as a lifecycle**, not the absence of payment: `confirmed` and `unpaid` from
  placement until `record_cod_remittance` — which is exactly the state phase 12's
  reconciliation reads.
- **Manual payments** (bank transfer, GCash screenshot) with proof in a **private**
  Storage bucket. A GCash receipt carries a buyer's name, amount and reference
  number; the public bucket would make each one readable by URL alone.
- **Refunds**, full and partial, in two steps — recorded then settled — so a refund
  that fails at the provider is visible as `pending` rather than lost.

### The amount is checked, never assumed

The provider reports what the buyer actually sent. A one-centavo payment against a
₱1,600 order lands on `partial`, not `paid`. Trusting a provider-supplied amount to
mean "settled" is the same class of mistake as trusting a client-supplied price,
which hard rule 6 already forbids on the way out. Asserted in both suites.

### Notable findings

| Symptom | Cause |
|---|---|
| `record_payment_event` was callable by `anon` | Postgres grants `EXECUTE` on every new function to **PUBLIC**. `revoke ... from anon, authenticated` does not remove a privilege held *through* PUBLIC — it succeeds, changes nothing, and reports no error. Anyone who could observe an invoice id could have marked any order paid. Fixed with `revoke ... from public`; a CI step now asserts the ACL for every money-moving function, so a *new* one cannot repeat it. |
| `payment_accounts_safe` returned "permission denied" for everyone, including the account's owner | A `security_invoker` view cannot read a column the caller has no grant on — and the view's whole job is to derive facts from exactly those columns. Now owner-run with `is_tenant_member()` in the `where` clause, the same pattern as the `storefront_*` views. |
| A freshly created store showed COD-only despite a connected account | The `payments.methods` default was backfilled at migration time but not added to `seed_tenant_defaults`, so every store created *afterwards* had no row. |
| The zone/payment `select` list degraded every field to an error type | PostgREST infers the row shape from the select string as a *literal* type, and `'a, ' + 'b'` widens it to `string`. |
| `pnpm db:types` broke the CI drift check it exists to satisfy | The script overwrote the file's hand-written header, which CI strips with `tail -n +10`. It now re-emits it. |

### Deliberately deferred

- **Manual payment, COD remittance and refund UI.** All three act on one order, and
  there is no order screen until phase 9. The functions, the RLS, the private bucket
  and a typed API module (`src/features/payments/payments-api.ts`) are finished and
  covered by the suite; only the screen is missing, and it belongs on the order
  detail view. Said plainly on the payments page rather than hidden.
- **A real Xendit sandbox call in CI.** The provider is unit-tested against payload
  shapes taken from Xendit's documentation, and the outbound path was exercised
  end-to-end against `api.xendit.co` (a 401 on a deliberately fake key, correctly
  classified `auth` and *not* retried). CI must not depend on a third party's
  sandbox being up.
- **Xendit Payment Requests / Payment Sessions.** Invoices are the right first
  integration: one hosted page, every PH channel, no card data in scope.
- **Payout and settlement reconciliation** — phase 12.

### Still needed outside the repo

- Each seller sets their own Xendit secret key and callback token on the payments
  screen, and pastes their webhook URL into Xendit → Settings → Webhooks (Invoices
  events). Nothing works until both halves are done, and the screen says so.
- The three OTP email templates must still be set in the Supabase **cloud**
  dashboard (Authentication → Emails); `config.toml` is local-only.
- The storefront needs a Node process, not just static hosting.
- `SUPABASE_SERVICE_ROLE_KEY` must be present in the storefront server's
  environment. The webhook route is the only thing that uses it, and it answers 503
  rather than pretending to work when it is absent.

**Gate:** `pnpm verify` (374 tests), `pnpm db:test` (302 assertions),
`pnpm db:test:concurrency` (23 assertions). All 13 migrations apply from scratch on
PG 17.6.

---

## Phase 9 — Order management

**Done when:** 50 orders can be moved from `confirmed` to `packed` in under 60
seconds.

**Measured** in Chromium at 390×844 @2×, against a real database, from landing on
the orders screen to all fifty being packed:

| | Result | Budget |
|---|---:|---:|
| 50 orders confirmed → packed | **1.2 s** | 60 s |
| Taps | **2** (select all, mark packed) | — |
| Horizontal overflow at 390px | 0 px | 0 |
| Console errors | none | none |

Verified in the database afterwards: 50 packed, and 50 `order_status_history` rows
written by the same statement that moved them.

What buys the 60 seconds is not rendering. It is that the whole batch is **one
call** — `orders_bulk_transition` does an `UPDATE ... WHERE id = any(...)` and an
`INSERT ... SELECT` for the timeline. Fifty single-row RPCs would be fifty round
trips (7.5 s of pure latency at a provincial 150 ms RTT) and fifty separate
transactions, so a dropped connection halfway would leave a seller unable to tell
which half moved.

### What shipped

- **Six saved views** — Needs confirmation / To pack / To ship / In transit / RTS /
  Today's COD — as tabs with live counts, plus All. Named rather than assembled from
  filters, because they are the questions a seller actually asks.
- **`orders_list`**, one jsonb document per page, with keyset pagination on
  `(placed_at, id)`. Not OFFSET: an order list is append-heavy at the top, and
  OFFSET silently repeats or skips rows as new orders arrive mid-scroll.
- **One search box** over order number, name and phone.
- **Bulk actions** with the offered set **intersected** across the selection, so a
  mixed selection only offers what every row can do.
- **`order_transitions`** as a table, read by both the database and the UI, so the
  pipeline has one definition. `transitions.test.ts` pins the client copy against
  the SQL fixture.
- **Order detail** in one round trip: items, customer, address, timeline, payment,
  internal notes, and the allowed transitions for *this* order.
- **`order_notes`** — staff notes, deliberately separate from `orders.notes` (the
  buyer's own message) and append-only: there is no UPDATE grant at all.
- **Manual order creation** for DM orders, priced by building a real cart and calling
  the same `cart_pricing` and `checkout_place_order` the storefront uses. A second
  pricing path would be a second place for the shipping resolver, the COD fee and
  hard rule 6 to disagree.
- **Packing slips and a picking list**, printed by the browser. "Save as PDF" in the
  print dialog is the PDF the spec asks for, and it works on the phone a seller
  actually holds — a server-side pipeline would add headless Chrome and a render
  queue to arrive at the same file. The picking list is one row per SKU across the
  whole batch, which is the thing that saves the time: walk the shelves once.
- **The phase-8 payment actions**, which were deferred for want of this screen:
  record a manual payment, remit COD, issue a refund.

### Notable findings

| Symptom | Cause |
|---|---|
| A packer could not mark an order packed | `packer` ranks *below* `staff`, so `has_tenant_role(t, 'staff')` excludes it — and packing is the entire job of the role literally called packer. Fulfilment moves are now `packer`; cancelling, which carries a refund decision, stays `staff`. |
| Searching a customer's phone found nothing | Phones are stored `+639171234567`; a seller types `09171234567`, and neither digit string contains the other. The single most likely search anyone would run returned zero rows. Both sides now go through `ph_national_digits()`. |
| Searching order `0001` returned eleven orders | The phone branch had a four-digit floor, so an order number matched the `00010`…`00019` inside other buyers' numbers. Floor raised to seven. |
| A 4px horizontal scrollbar at 390px, on `/orders` only | A `-mx-4` "bleed to the screen edge" that assumed 16px shell padding; the shell is `px-3 sm:px-6 lg:px-8`. Removed rather than re-guessed. |

### Two things the sabotage runs showed

Removing the tenant scope from the bulk UPDATE does not merely fail an assertion —
it violates `order_status_history_tenant_id_order_id_fkey` and aborts. The composite
FK makes a cross-tenant timeline row *unrepresentable*, so a cross-tenant bulk move
cannot be written even if the WHERE clause is wrong. That is the phase-4 lesson
paying off in a phase written five sessions later.

Switching `today_cod` from a Manila day to a UTC day drops an order placed at 07:00
Manila (23:00 UTC yesterday) — 49 instead of 50. A seller doing an 8am COD cutoff
would be missing two hours of the day's orders with nothing to indicate it. Now
asserted, not just reported.

### Deliberately deferred

- **The manual-order UI.** `create_manual_order` is complete, tested and reachable
  from the API module; the form that drives it needs a product picker, which is a
  screen of its own. The RPC is what phase 13's live-selling capture will call.
- **Waybill search.** The spec lists it; there are no waybills until phase 10
  creates `shipments`. `order_detail` already returns an empty `shipments` array so
  the screen has a shape to grow into.
- **Saved views are fixed, not user-defined.** The six named ones cover the workflow;
  custom views are a settings surface with no demand behind it yet.

**Gate:** `pnpm verify` (383 tests), `pnpm db:test` (334 assertions),
`pnpm db:test:concurrency` (23 assertions). All 14 migrations apply from scratch on
PG 17.6.

---

## Phase 10 — Courier integration

**Done when:** 40 orders are booked and one PDF of 40 labels downloads in under 30
seconds.

**Measured** over real HTTP against the real server and database, with a stand-in
courier returning genuine PDF labels:

| | Result | Budget |
|---|---:|---:|
| 40 booked, 40-page PDF (120 ms courier latency) | **0.9 s** | 30 s |
| Same, at 450 ms courier latency | **3.5 s** | 30 s |
| Distinct waybills | 40 | 40 |
| Orders moved to `shipped` | 40 | 40 |
| Timeline rows written | 40 | 40 |

Re-running the same batch books nothing and reports all 40 as already booked. An
unauthenticated call gets 401; another tenant's member gets 403.

### What shipped

- **`CourierProvider` for J&T and Flash**, deliberately different API shapes —
  numeric status codes vs string states, peso decimals vs integer centavos, nested
  vs flat bodies. Two couriers that looked alike would not prove the boundary holds.
- **Credentials encrypted at rest** with pgcrypto and a key held in the *server's
  environment*, never in Postgres, so a stolen database dump is useless on its own.
  Not Supabase Vault, which keeps the key in the same instance — and whose extension
  version differs between the local stack and the image CI runs.
- **Bulk booking on the Node server**, because a credential a browser can hold is
  one a browser extension can read. The dashboard sends its own Supabase token and
  the *database* decides whether it may book; credentials are decrypted only after
  that returns.
- **One merged PDF**, 8 label fetches in parallel, with a named placeholder page for
  any label that could not be fetched. A seller with 39 good labels needs the 39
  printed now and the missing one identified — not a failed download.
- **A booking failure queue** that separates what a retry can fix from what it
  cannot. An unserviceable barangay is a 400 and gets no `next_retry_at` at all;
  a 503 gets an exponential curve capped at an hour. Verified: a batch with 5
  permanent failures booked the other 35, and a re-run resolved 4 transient ones and
  left the permanent one open.
- **The waybill and `shipped` are written together**, so an order can never say
  shipped with nothing to track.

### The find that matters most

**Phase 8's own security fix had broken the payment webhook, and this phase found
it.** `revoke ... from public` is what actually locks a function down — and it
revokes from `service_role` too, because in Supabase that role has `BYPASSRLS`
(which bypasses *policies*) and is not a superuser (so it still needs *grants*).

From that commit until this one, `record_payment_event` answered "permission denied"
and a paid GCash order would never have reached `paid`. The phase-8 HTTP proof ran
*before* the revoke and was not repeated after it — the SQL suite went green and
that was taken as sufficient.

The CI check added in phase 8 passed the whole time, because "not callable by anon"
is trivially true of a function nobody can call at all. There is now a second check
asserting the server *can* execute what it needs, and it fails on exactly this
regression.

### Notable findings

| Symptom | Cause |
|---|---|
| The payment webhook returned 42501 for a whole phase | `revoke ... from public` also revoked `service_role`. See above. |
| Booking a batch reported "2 skipped that had already moved" | The result banner reused the bulk-move wording, so two *failed* parcels were described as duplicates — pointing the seller at the wrong explanation and hiding that two orders needed attention. |
| `/api/couriers/*` would 404 under `pnpm dev` | One process serves the dashboard and the API in production; in development they are Vite and the Node server. A dev-only difference is the worst kind, so `vite.config.ts` now proxies `/api`. |

### Deliberately deferred

- **`courier_live` shipping rates still charge the rate's flat fallback.** The
  `quote()` half of both providers is implemented and tested, but wiring it into
  checkout means a courier round trip on the critical path of a buyer's checkout,
  with a caching and timeout story of its own. Phase 7 already says the fallback
  amount is charged until then, and the shipping screen says so on the rate.
- **Tracking is phase 11.** `parseWebhook` and `track()` are implemented and mapped
  into Selld's status vocabulary; the inbound webhook route and `shipment_events`
  land with buyer notifications.
- **Retries are queued, not driven.** `courier_booking_failures` carries the curve
  and re-running a batch retries the open ones, but nothing runs on a timer yet —
  the scheduler belongs with phase 11's tracking poller.
- **LBC and Ninja Van.** The registry and interface take them; the spec asked for
  J&T and Flash first.

### Still needed outside the repo

- `COURIER_CREDENTIALS_KEY` must be set in the storefront server's environment.
  Without it, booking answers 503 rather than pretending to work. Generate with
  `openssl rand -base64 32`, and **keep it** — rotating it makes every stored
  credential undecryptable.
- Each seller connects their own J&T or Flash account on the shipping screen.

**Gate:** `pnpm verify` (405 tests), `pnpm db:test` (355 assertions),
`pnpm db:test:concurrency` (23 assertions). All 15 migrations apply from scratch on
PG 17.6.

---

## Phase 11 — Tracking & buyer notifications

**Done when:** the "nasaan na po order ko" message volume is structurally
eliminated — the buyer gets the answer before they ask.

That is a claim about a conversation that stops happening, so it was decomposed
into the properties that would have to hold for it to be true, and each one
measured over real HTTP against the real server and database:

| | Result |
|---|---|
| A courier scan moves the order with nobody touching the dashboard | yes |
| Texts sent for that scan | **1** |
| Credits charged | **1** |
| The text carries a link to the answer | yes |
| The same scan replayed (courier retry, then poller) | 0 more texts, 0 more charges, 0 extra timeline rows |
| A *different* scan meaning the same thing (`4` vs `400`) | recorded, **still 0 more texts** |
| The link answers with no login, no cookie | 200, in the store's branding |
| A late out-of-order scan | on the timeline, does not un-deliver, does not rewind the parcel |
| A push for a waybill nobody booked | `unmatched`, nothing changes |
| A wrong webhook secret | 404 |

### What shipped

- **`shipment_events`, one row per courier scan**, with
  `unique (shipment_id, raw_code, occurred_at)`. Idempotency is a constraint, not a
  check: a courier retrying a webhook is normal traffic, not an error case.
- **A polling fallback over the same code path.** `shipments_to_poll()` returns only
  parcels still moving that nobody has heard about recently. J&T's webhook setup is
  per-merchant and frequently just not done, and a seller whose tracking is silent
  has exactly the problem this phase exists to remove. The poller and the webhook
  call the same function, because a fallback that behaves differently produces bugs
  that only appear for the couriers nobody tests.
- **The notification decision lives in SQL.** `record_shipment_event` returns
  `notifyEvent` and the server sends whatever it is told. Deciding in the handler
  would have put the rule in two places the moment the poller was written.
- **Two layers of duplicate defence**, because they catch different things.
  `shipment_events` collapses the same *scan*; `integration_logs (tenant,
  order:event)` collapses the same *notification*, which is what stops two distinct
  scan codes that both mean "out for delivery" from sending two texts.
- **Per-tenant Taglish SMS templates**, seeded for every new tenant by
  `seed_tenant_defaults` — a seller who has to write five templates before tracking
  works is a seller whose tracking does not work. No default contains `₱`; the
  tenancy suite asserts it.
- **A credit ledger, not a counter.** Same reasoning as `stock_movements`: a balance
  a seller cannot explain is a bill they will not trust. `sms_credit_move` holds a
  per-tenant advisory lock and returns null rather than overdrawing.
- **A public tracking page at `/track/{order_number}`**, server-rendered, no login,
  readable with JavaScript disabled. The order number is the only credential, so the
  page is deliberately thin: status, a four-step progress bar, the courier and
  waybill, and the timeline. First name and destination city — enough to recognise
  your own parcel, useless to anyone else.

### The find that matters most

**`sms_credit_balance` was readable by every signed-in user, for any store.**
`SECURITY DEFINER` plus a grant to `authenticated` is not tenant scoping — the
definer bypasses the RLS on the ledger, so passing another tenant's id returned
their balance. Small as leaks go, and still one: it says how much a competitor
spends on SMS and how close they are to running out.

The fix is the phase-6 `apply_reservation` split — an unchecked
`sms_credit_balance_raw` for the definer-owned functions that need a balance
mid-send, and a membership check on the one that is granted out. The notification
path *must* use the raw one: it runs as the definer with no JWT, so a membership
check there would tell it every seller has no credits and silence every message.

### Notable findings

| Symptom | Cause |
|---|---|
| The balance flicked between two numbers, and the data-layer probe passed about half the time | `sms_credit_balance` ordered by `created_at desc, id desc`. `now()` is the *transaction* timestamp, so rows written in one transaction tie — and the tie broke on a random uuid. Ordering is a `bigint` identity column now. Sabotage: 2 of 6 runs fail with the old ordering, 6 of 6 pass with the new. |
| Every tracking SMS pointed at the webhook's own hostname | The link was built from `url.origin` of the request that triggered it — which is a courier's webhook arriving on the platform host, not the seller's storefront. `sms_render_for_order` now builds `{scheme}://{slug}.{host}`, or the store's custom domain: the same rule `resolveSurface` applies in the other direction. |
| `public_tracking` 404'd against a function that was right there | PostgREST resolves an overload by the *set of argument names* in the body. `p_domain` was added to the SQL and not to the call, and a key that is absent is a key PostgREST never sees. The error even names the signature you meant. |
| `picked up` appeared mid-timeline, lowercase and unpunctuated | The page had one status map; the database has two vocabularies — `orders.fulfillment_status` and `shipment_status_map` — that overlap without being the same list. `tracking-page.test.tsx` now walks both. |

### Deliberately deferred

- **Nothing drives the poller on a timer.** `pollShipments()` is written, tested and
  shares the webhook's code path, but the scheduler that calls it every few minutes —
  along with phase 10's booking-retry curve — belongs with the job runner, not with a
  request handler.
- **Semaphore is not wired.** Sending still goes through the `log` provider, which
  reports realistic per-segment costs so the ledger arithmetic is exercised. The
  provider registry means this is one registration, not a change to this code.
- **Credit top-ups have no UI.** The ledger takes `topup` rows and the balance is
  visible; buying credits is a payments-shaped feature and belongs with billing.
- **No seller-facing template editor.** The templates are per tenant and editable by
  an admin through the API, with RLS asserted — the screen for it is UI work this
  phase did not need to prove its done-when.

### Still needed outside the repo

- `COURIER_WEBHOOK_SECRET` must be set in the storefront server's environment, and
  the resulting URL — `/api/webhooks/courier/{jnt|flash}/{secret}` — registered with
  each courier. Neither J&T nor Flash signs its tracking pushes, so that path segment
  *is* the credential. Unset, the endpoint answers 503 and tracking falls back to
  polling.

**Gate:** `pnpm verify`, `pnpm db:test` (394 assertions),
`pnpm db:test:concurrency`. All 16 migrations apply from scratch on PG 17.6.

---

## Phase 12 — COD reconciliation & RTS control

**Done when:** a seller can answer "how much COD is the courier still holding, and
which parcels are unaccounted for" in one screen.

**Measured** in a real browser at 390px, against the real database, with a J&T
statement file of the shape a courier actually exports — branding rows above the
header, peso signs, a thousands separator and a footer total:

| | Result |
|---|---|
| The screen answers the first question | **₱4,158.00 held across 11 parcels**, aged into four buckets |
| …and the second | 4 overdue past 30 days, 1 unknown waybill, 1 short payment, listed separately |
| Statement import: 5 lines | 3 matched, 1 variance, 1 unknown waybill |
| Orders marked paid **by importing** | **0** — an import is a draft |
| After posting | 3 paid, 1 partly paid (the short one) |
| Horizontal overflow at 390px | 0 px |
| Console errors or warnings | none |

### What shipped

- **Statement import for CSV *and* `.xlsx`**, parsed in the browser. Every courier
  portal exports `.xlsx`; a seller told "convert it to CSV first" simply does not
  use the feature.
- **A hand-written 250-line xlsx reader** rather than SheetJS. This parses a file a
  user uploads, so it is an attack surface, and the part of the format we need is
  small: a ZIP of XML, cells in `sheet1.xml`, strings in `sharedStrings.xml`. No
  formula evaluation, no external references, no macros. Inflation goes through
  `DecompressionStream`, which browsers and Node both provide, so the tests run on
  the same implementation that ships.
- **Matching happens in SQL, never in the importer.** The client says "the courier
  claims waybill X paid ₱1,450"; `cod_import_statement` decides whether X is ours,
  whether it agrees with the order, and whether it was already paid. A client that
  could assert `match_status` could assert that an unpaid order was paid.
- **Import and post are two acts.** An import produces a draft with a full
  breakdown; posting is a separate click. That costs a tap and buys an undo — an
  import that posted immediately would turn "wrong courier in the dropdown" into
  false paid flags spread across the order book.
- **Five verdicts, not two.** `matched`, `variance`, `unknown_waybill`, `duplicate`,
  `not_cod`. Only the first two post; the rest are the "unaccounted for" half of the
  done-when and each needs a different thing done about it.
- **`record_rts`** does the three things that must not happen separately: moves the
  order, puts the goods back through the movement ledger with reason `rts`, and
  records what the round trip cost. Restocking is asked, not assumed — a parcel that
  spent two weeks on a van often comes back unsaleable, and only the person holding
  the box knows.
- **`buyer_risk_flags`**, an RTS rate per phone number keyed on national digits, and
  a COD block that bites at `checkout_place_order`. The *score* never blocks anyone:
  a computed rate can be wrong, and refusing someone's money on a signal they cannot
  see or appeal is a decision a human makes.
- **A cross-tenant risk pool**, opt-in in both directions, keyed by a salted hash
  with no tenant column anywhere in the aggregate. A lookup returns the other
  stores' numbers only — a seller reading their own contribution back would take it
  for corroboration.

### The find that matters most

**A short remittance leaves the order `partial`, not `paid`** — and that fell out of
routing posting through phase 8's `record_cod_remittance` instead of writing
`payments` rows directly. One code path decides what "paid" means, so a parcel the
courier paid ₱300 for against a ₱378 order lands as partly paid, with the shortfall
visible on the order itself and not only in the variance report.

Going the other way — refusing to post a variance at all — would have been worse:
the parcel would be neither paid nor outstanding, which is the one state a
reconciliation screen cannot explain.

### Notable findings

| Symptom | Cause |
|---|---|
| A statement's last data row silently vanished | The XML row matcher tried `<row>…</row>` before `<row/>`, so a self-closing spacer row swallowed the next real row up to its `</row>`. In a courier file that is a missing parcel with no error anywhere. Order in the alternation is load-bearing. |
| `1,450.00` read as ₱1.50 | A naive decimal split. The separator is whichever of `.` and `,` appears *last*, which is the only rule that gets `1,450.00` and `1.450,00` both right. |
| `COD Fee` matched as the payout column | "COD Fee" contains "cod". Fee columns are now claimed *before* amount candidates, or a seller's whole payout reads as the courier's cut. |
| A `record` never assigned cannot be tested for null | `buyer_risk_lookup` held the shared row in a plpgsql `record`; Postgres refuses even `v_shared.x is null` on one that was never assigned. It builds jsonb instead. |
| The sabotage sweep left a grant behind | Restoring with `revoke … from public` did not remove the EXECUTE granted directly to `authenticated` — the exact inverse of the phase-8 trap, and it broke the next suite run rather than production. |

### Deliberately deferred

- **No scheduler still.** Nothing polls couriers or drives phase 10's retry curve on
  a timer; that belongs with a job runner, not a request handler.
- **`update_rts_cost` has no screen.** The function exists and is tested — the real
  return charge arrives weeks later on the next statement — but the UI for
  correcting it does not.
- **The shared pool has no settings screen.** Both flags default to off and are
  editable through `tenant_settings`; the opt-in UI, with the explanation it
  deserves, is a settings-page feature.
- **Statement periods are not parsed.** `period_start`/`period_end` exist on the
  table and are left null; couriers write the period as free text in a preamble row
  and guessing it wrong is worse than leaving it empty.

### Still needed outside the repo

- A `buyer_risk_salt` row in `platform_secrets`, at least 16 characters, if the
  cross-tenant pool is to work at all. Without one `buyer_risk_hash()` returns null
  and every pool path quietly no-ops — deliberately, because hashing with a default
  salt would look safe and not be.

**Gate:** `pnpm verify` (442 tests), `pnpm db:test` (442 assertions),
`pnpm db:test:concurrency`. All 17 migrations apply from scratch on PG 17.6.

---

## Phase 13 — Live selling capture

**Done when:** a 200-comment live session produces correct orders with zero manual
encoding, and a dry-run replay of a real comment log scores ≥95% parse accuracy.

**Measured** over the real webhook, against the real database, with 200 comments in
the proportions a Philippine live session actually has — mostly bare `mine` while
the seller holds something up, a long tail of Taglish and Bisaya variants, questions
and chatter mixed through, buyers double-posting, and Facebook redelivering ten of
them:

| | Result |
|---|---|
| 200 comments through the webhook | **2.1 s** |
| Parse accuracy | **200/200 = 100%** (bar: 95%) |
| Corpus replay (122 hand-labelled comments) | **100%** |
| Claims held, without anyone typing | 157 claims, 149 buyers, 178 units |
| Stock actually reserved | 178, matching the claims exactly |
| Chatter kept for the operator | 43 of 43 |
| Redelivered webhooks | 0 extra comments, 0 extra units, `200 duplicate` each |
| A buyer taps the Messenger link | 303 → checkout, cart cookie handed over, claim converted |
| Session ends | 178 holds → 1 (the converted order's) |

### What shipped

- **A Taglish/Bisaya claim parser** with a hand-labelled corpus of 122 comments,
  written **before** the parser and scored as a whole. It reads `mine`, `sakin`,
  `akoa`, `sa ako`, `kuha ko`, quantities as `2pcs`/`x2`/`dalawa`/`duha`/`two`, codes
  split as `A 1` or `A-1`, several claims in one comment, and — the part that
  matters most — it refuses `ang ganda ng A1` and `magkano po A1?`.
- **The bare `mine`.** The commonest comment in a PH live sale is one word, and it
  means "the thing you are holding". `live_sessions.current_item_id` is what makes
  it parseable, and tapping a row on the board is what sets it.
- **Reserving in SQL, parsing in TypeScript.** Thirty buyers claiming the last two
  units in the same second is the normal case, so holding stock goes through phase
  4's sorted advisory locks. `live_ingest_comment` treats the parse as a *claim
  about a claim* and re-resolves the code against the session's own items.
- **Idempotency on Facebook's own comment id.** A redelivered webhook returns
  `duplicate` with a 200 — not a 5xx, because Facebook retries a 5xx forever and
  disables a subscription that keeps erroring.
- **A claim mints a cart**, and the Messenger link (`/live/claim/{token}`) adopts
  it and drops the buyer on checkout with the right item already in it. No price
  lives on the live item: `cart_pricing()` is still the only place money is computed.
- **An operator console** polling every two seconds: the board with what is left,
  the claim feed showing the comment behind each claim, and — deliberately — the
  comments the parser could *not* use. A console that only shows successes hides
  its own failures.
- **Expiry.** A claim holds stock for the session's window and then goes back on
  sale; ending a session releases everything still held.

### The find that matters most

**`ON DELETE SET NULL` on a composite foreign key nulls every column in the key**,
including the denormalised `tenant_id` — which is `NOT NULL` on all sixteen tables
that had one. So before this phase:

- deleting a product that had ever been ordered raised
- deleting a category with products raised
- deleting a customer who had ordered raised
- deleting a location, a shipment or a cart with an order attached raised

Every one of those is a button in the dashboard that answered "something went
wrong". It was invisible because the tenancy suite deletes *tenants*, where the
children cascade away for a different reason and the SET NULL never fires. Fixed
with Postgres 15's `on delete set null (column_list)` across all sixteen, with a CI
step so the next composite FK cannot repeat it.

### Notable findings

| Symptom | Cause |
|---|---|
| Every row on the board lost its `aria-pressed` | `x.id = v_session.current_item_id` is SQL `NULL`, not `false`, when nothing is on screen — and a null reaches React as "omit this attribute". `coalesce(..., false)`. |
| The setup panel collapsed after every item added | It was rendered in two different branches of the tree, so the first item unmounted and remounted it and its open state reset. A seller listing thirty items had to re-open it thirty times. One instance, `compact` as a prop. |
| The operator's comment box got a 403 | `live_ingest_comment` is service-role only, correctly — but a seller on the manual channel *is* the ingest. A checked `live_ingest_manual` wrapper, the same split as `reserve_stock`/`reserve_stock_raw`. |
| A converted claim held its unit twice | In this schema an order *reserves*; `ship_reservation` is what turns a hold into a sale. So at checkout the claim and the order both held the same unit, and the first version of the trigger reasoned from a misread of `apply_reservation`. The claim hands its hold over. |

### Deliberately deferred

- **The Send API is not wired.** `MessengerProvider` is a port with a `log`
  implementation, exercised on every claim; the real Send API call needs a page
  access token, which needs OAuth, which is phase 14. Registering it there changes
  no line of the live-selling code.
- **No expiry scheduler.** `live_expire_claims()` is written, tested and released by
  ending a session; the timer that sweeps mid-broadcast belongs with the job runner
  that phases 10 and 11 are also waiting on.
- **No live-only price.** A live item is a variant at the variant's price. A
  live-only price would have to flow through `cart_pricing()` to be charged, and a
  displayed price that is not charged is the phase-6 snapshot trap wearing a hat.
- **Instagram and TikTok** are in the channel CHECK and have no ingest.

### Still needed outside the repo

- `LIVE_WEBHOOK_SECRET` in the server environment, and the resulting URL —
  `/api/webhooks/live/facebook/{secret}` — subscribed on the page. `FB_APP_SECRET`
  is optional but, when set, `X-Hub-Signature-256` becomes mandatory.
  `FB_WEBHOOK_VERIFY_TOKEN` is needed for Facebook's subscription handshake.

**Gate:** `pnpm verify` (458 tests), `pnpm db:test` (476 assertions),
`pnpm db:test:concurrency`. All 18 migrations apply from scratch on PG 17.6.

---

## Phase 14 — Messenger & social integration

**Done when:** a comment on any post triggers a DM with the store link within 5
seconds.

**Measured** over the real webhook on the real server, against a fake Graph API
answering with 120 ms of latency per call — so the number below includes the
signature check, the account lookup, the comment insert, the keyword match and the
Send API round trip:

| | Result |
|---|---|
| Comment received → DM sent | **57 ms** (bar: 5 000 ms) |
| Whole webhook request | 356 ms |
| A 40-comment burst on one post | 1.1 s, worst buyer waited **836 ms** |
| DMs sent in that burst | 26 of 26 questions; the 14 "ang ganda!" got none |
| Account lookups for those 40 | 1 |
| Facebook redelivering the comment | 0 sends, 1 comment row |
| Public reply | sent, and always *after* the DM |
| Page access token in a URL | never — `Authorization: Bearer`, asserted |

### What shipped

- **`social_accounts`**, with the page access token encrypted at rest under a key
  held in the server's environment. No `select` grant, no policy at all: the
  `social_accounts_safe` view derives "is this connected", "has it expired", "is it
  actually subscribed" without ever carrying the secret.
- **Facebook OAuth**, start to finish: a signed `state` minted only after
  `has_tenant_role(tenant, 'admin')` passes under the seller's own token, the code
  exchange, the long-lived upgrade, `/me/accounts`, and `subscribed_apps` — because
  a page that is connected but not subscribed looks perfectly fine and is
  completely silent.
- **The comment play.** A comment with a keyword gets a private reply carrying the
  store link, then a short public "sent you a DM po" for everyone else reading the
  thread. The private reply is its own Facebook affordance and needs no open
  messaging window — the person just commented publicly — which is exactly why it
  is the one send this phase leans on.
- **A unified inbox** with the 24-hour window on every row, in hours, sorted so the
  closing conversations are answered first. Replies go through the server, never
  the browser, because the browser must never hold a page token.
- **Keyword auto-replies** in the words PH buyers actually type — `magkano`,
  `pila`, `price`, `order`, `cod`, `store`, `link` — seeded for every store, old
  and new, and matched on **whole words** in Postgres (`\m`…`\M`). A `contains`
  rule for `cod` fires on `codigo`, and a seller who wrote one rule gets a robot
  answering everything.
- **Customer auto-linking by PSID**, so a message from a 16-digit number shows up
  as a person with an order history.

### The rule that is not ours to bend

Facebook lets a page send a **standard** message only within 24 hours of the
person's last message. Outside it a send needs a *message tag*, the tags are narrow,
and misusing one costs the page its messaging permission — which for a seller whose
business runs through Messenger is the business.

So the window lives in the database, not in the application:
`message_send_allowed()` is the decision, `record_outbound_message()` refuses to
record a send it should not have made, and every path asks **before** it sends
rather than after. The proof drives all of it: standard inside 24 hours,
`window_closed` outside, `POST_PURCHASE_UPDATE` allowed, an invented tag refused,
`HUMAN_AGENT` refused to an automation and allowed to a person, and a page never
able to open a conversation with someone who has never written to it.

### Notable findings

| Symptom | Cause |
|---|---|
| Phase 12's COD and returns functions were callable by `anon` | Granted to `authenticated` and never revoked from **PUBLIC**, which is Postgres's default grantee. CI's own list named them, so the check was red rather than green — found while adding this phase's entries to it. Every one checks membership internally, so nothing leaked; closed anyway. |
| The 40th commenter on a popular post waited 7 s | Comments were handled one at a time, at two Graph round trips each. Bounded to eight at a time; the same burst now finishes in 1.1 s. Bounded rather than unbounded, because being rate-limited costs every seller on the deployment. |
| The OAuth callback connected nothing | `social_account_connect` checked `has_tenant_role`, and the callback arrives as a top-level navigation with no session at all. The authorisation is one step earlier, carried by the signed `state`; the function is service-role only, like `set_courier_credentials`. |
| A policy refusal would have been retried | `withRetry` retries anything it does not recognise, which is right for a network blip and is how a page that has been told "you may not send this" says it again on a backoff curve. Only `transient` is retried now. |
| `subcode` read nothing | Facebook sends `error_subcode`. Reading the wrong key degrades every "outside the window" refusal to whatever the top-level code happened to be — sometimes a transient one. |
| A phase-13 assertion failed about half the time | Its fixture picked a variant with `select ... limit 1` and no `ORDER BY`; on the runs that picked one the order tests had already reserved, the first claim came back `sold_out`. It builds its own product now. |
| An anon assertion passed for the wrong reason | `set local role anon` does not clear the JWT claims, so `is_tenant_member` kept answering as the seller. `tests.logout()` first. |

### Deliberately deferred

- **Instagram** is stored (`ig_user_id`, captured at connect time) and not yet
  ingested. IG comments arrive on a different webhook field with a different
  payload, and guessing at it would be a second parser nobody has driven.
- **Attachments** are recorded on inbound messages and cannot be sent. A seller
  sending a photo back needs an upload endpoint, which is a phase of its own.
- **No message-tag scheduler.** Tags are offered to a person typing in the inbox;
  automated tagged sends (a shipping update to someone outside the window) belong
  with the job runner phases 10, 11 and 13 are also waiting on.
- **One page per store.** The schema allows several and the UI connects several;
  nothing yet lets a seller choose *which* page a reply goes out from, because
  every path so far is answering something that arrived on a known page.

### Still needed outside the repo

- `FB_APP_ID` and `FB_APP_SECRET` from a Facebook app with `pages_messaging`,
  `pages_manage_metadata`, `pages_read_engagement` and `pages_manage_engagement`
  approved, plus `SOCIAL_WEBHOOK_SECRET` and `SOCIAL_TOKEN_KEY` in the server
  environment.
- The webhook URL `/api/webhooks/social/{SOCIAL_WEBHOOK_SECRET}` registered on the
  app with the `feed`, `messages` and `messaging_postbacks` fields, and
  `FB_WEBHOOK_VERIFY_TOKEN` matching what is configured there.
- `SELLD_PUBLIC_URL` when the server sits behind a proxy that rewrites the host:
  Facebook compares `redirect_uri` byte for byte.

**Gate:** `pnpm verify` (476 tests), `pnpm db:test` (528 assertions),
`pnpm db:test:concurrency`. All 19 migrations apply from scratch on PG 17.6.

---

## Phase 15 — Customers & CRM

**Done when:** "customers who bought skincare, spent over ₱2,000, haven't ordered
in 60 days, zero RTS" is a saved segment.

**Measured** against a fixture built out of near misses, because the near misses
are what prove a segment rather than a filter that happens to return people:

| Customer | Why they are in, or out |
|---|---|
| Ana Reyes | **in** — bought a *serum*, a child of Skincare; ₱2,500 delivered; quiet 90 days |
| Fely Mendoza | **in** — exactly ₱2,000, and the bar says "at least" |
| Gina Bautista | **in** — cancelled an order yesterday, and a cancellation is not an order |
| Bea Cruz | out — ₱1,999, one peso short |
| Carla Lim | out — ordered 30 days ago |
| Divina Santos | out — one parcel came back |
| Elena Tan | out — bought bags |
| Hazel Ong | out — ₱2,500 promised, still unpaid in a van |

Saved, then re-read with a **live** count; Ana orders again and drops out of her
own segment on the next read. In the browser at 390px the count narrows
6 → 5 → 4 → 3 → 2 as each condition is added, which is the whole interface.

### What shipped

- **Lifetime value that is true.** `customers.total_spent_centavos` and
  `total_orders` were incremented by hand inside `checkout_place_order`. They are
  now a **projection of the orders table**, recomputed by trigger, with a guard
  that raises on a direct write — plus `pending_spent_centavos`,
  `delivered_orders`, `rts_orders`, `cancelled_orders`, `first_order_at` and
  `last_order_at`.
- **A segment engine that is one static query.** Eleven criteria, each read out
  of a JSONB definition by key and cast — never concatenated. A category matches
  the categories under it, "hasn't ordered in 60 days" includes people who have
  never ordered, and "zero RTS" means zero.
- **Saved segments** that store the question rather than the answer, so the count
  is right the morning after.
- **Customer profiles** with order history, tags, saved addresses, and an RTS
  rate computed over parcels that *reached a conclusion* rather than over
  everything ever placed.
- **Import** from Shopee, Lazada and TikTok Shop order exports and from a
  spreadsheet somebody typed — header found under the branding rows, the
  *receiver* preferred over the username, one buyer's nine orders collapsed into
  one person, and every number normalised to `+63…` before it is stored.
- **Merge**, which repoints orders, carts, addresses and Messenger threads,
  keeps whatever the survivor was missing, and lets the projection recompute
  itself.

### Notable findings

| Symptom | Cause |
|---|---|
| Lifetime value counted money that never arrived | The hand-rolled increment ran once at checkout and never again, so a cancellation, an RTS and a refund were all invisible to it. Recomputation from the ledger cannot drift; an incremental counter is wrong forever the first time a path is missed. |
| A phone number Excel had mangled would have become somebody else's | `9.17123E+09` is a *displayed* value with the tail already gone. Padding it to ten digits is a real, wrong number. The corpus caught it; the parser now refuses what it cannot restore. |
| A TikTok export identified as Shopee | `Order ID` was in the Shopee fingerprint, and every marketplace on earth has a column called that. |
| A tenancy assertion passed for the wrong reason | It wrote `rts_orders = 0` over a customer whose count was already 0, so the guard correctly saw no change. A guard test has to write a *different* value. |
| The segment builder's count read 0 in the browser | The fixture's category was called "Skincare" and so was the demo store's, so the dropdown picked the wrong one. The engine was right; the harness was ambiguous. |

### Deliberately deferred

- **No automatic duplicate finder.** `customers` is unique on
  `(tenant_id, phone)`, so a duplicate is two rows for one *person* — same human,
  two numbers, or two spellings of a name. "Same phone" is a fact and "same
  person" is a judgement, and merging the wrong two is not reversible, so the
  merge takes two ids a seller chose.
- **No segment membership snapshots.** Phase 16 sends to a segment, and *then*
  there is a reason to record who was in it at send time — as part of the
  broadcast, not as part of the segment.
- **Addresses are stored and not yet offered at checkout.** The table and the
  profile are here; wiring them into the storefront's address step is a change to
  a page carrying a 2.0s LCP budget and belongs with its own measurement.
- **No CSV export.** Import first: a seller arriving has a file, a seller leaving
  has a lawyer's request, and phase 20's data-export flow is where that belongs.

**Gate:** `pnpm verify` (499 tests), `pnpm db:test` (556 assertions),
`pnpm db:test:concurrency`. All 20 migrations apply from scratch on PG 17.6.
