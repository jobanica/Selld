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
| 10 | Courier integration | ⬜ Next |
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
