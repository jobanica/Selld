# Selld — working notes for Claude Code

Multi-tenant ecommerce + order operations platform for Philippine social sellers.
Build one phase per session, in order. The full roadmap is in
[`docs/build-spec.md`](docs/build-spec.md); who we're building for is in
[`docs/avatar.md`](docs/avatar.md).

**Current state: phase 8 complete.** Next up is phase 9 (order management dashboard).

---

## Commands

```bash
pnpm install          # pnpm, not npm — see "Package manager" below
pnpm dev              # dashboard SPA (Vite) on :5173
pnpm dev:store        # storefront SSR server on :5174 — try rheas-finds.localhost:5174
pnpm verify           # typecheck + lint + test + build — run before every commit
pnpm test:watch       # tests in watch mode
pnpm start            # production storefront server (needs `pnpm build` first)
pnpm seed:demo        # demo store + generated product images, for storefront work
pnpm lighthouse       # Lighthouse mobile against a running `pnpm start`

pnpm db:start         # Supabase local stack (needs Docker)
pnpm db:reset         # reset + re-run migrations, then reseed PSGC
pnpm db:new <name>    # scaffold a migration
pnpm db:types         # regenerate src/lib/supabase/database.types.ts — after EVERY migration
pnpm db:test          # run supabase/tests/*.sql (RLS isolation). Needs a database.
pnpm db:test:concurrency  # oversell prevention, with real parallel connections
scripts/db-reset-local.sh # rebuild a bare pg container from the migrations

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

## Writing a tenant-scoped table (do this every time)

The security boundary is `public.is_tenant_member(tenant_id)` — **not**
`current_tenant_id()`. Policies ask "is the caller a member of the tenant that owns
this row?", which the client cannot influence. `current_tenant_id()` is for
defaults only; it validates membership before returning anything, so a spoofed
`x-selld-tenant` header can at worst return one of the caller's own tenants.

```sql
create table public.widgets (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ...
);
create index widgets_tenant_idx on public.widgets (tenant_id);

alter table public.widgets enable row level security;
alter table public.widgets force  row level security;

create policy "Members read widgets"   on public.widgets for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write widgets"    on public.widgets for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
-- update needs BOTH using and with check, or a row can be moved to another tenant.
create policy "Staff update widgets"   on public.widgets for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));

grant select, insert, update, delete on public.widgets to authenticated;
```

Then **add assertions to `supabase/tests/tenancy-isolation.sql`** for the new
table. The suite is the thing standing between us and a cross-tenant leak, and it
only covers what it is told about.

Gotchas learned the hard way:

- **RLS helpers must be `SECURITY DEFINER` with `search_path = ''`.** A policy on
  `tenant_members` that queried `tenant_members` directly would recurse forever.
  This works because the `postgres` role has `BYPASSRLS`, which is why
  `FORCE ROW LEVEL SECURITY` does not break it.
- **`UPDATE`/`DELETE` blocked by RLS affect zero rows — they do not raise.** Assert
  on the row count, not on an exception. `INSERT` violating `WITH CHECK` does raise.
- **Point user FKs at `public.profiles(id)`, not `auth.users(id)`.** Same cascade
  behaviour (profiles cascades from auth.users), but one unambiguous FK, which is
  what lets PostgREST embed `profiles(...)`.
- **`auth.users` has no `phone` column** in the Postgres image CI runs. Read phone
  from `raw_user_meta_data` instead or the migration fails there.
- **Never expose a bearer token through a `SELECT` policy.** `invitations.token` has
  no read policy at all; redemption goes through `accept_invitation()`, which also
  checks the token was issued to the caller's own email.

## The two surfaces render differently

The dashboard is a client-rendered SPA. The storefront is **server-rendered** by
`server/storefront-server.ts` (Node), because it carries an LCP < 2.0s on 3G
budget and a CSR load cannot meet it — HTML, then JS, then boot, then a data
fetch is four sequential round trips before anything paints, and at 150ms RTT the
round trips alone blow the budget. Prerendering at build time was the other option
the brief allowed and does not work here: sellers create stores at runtime, so the
page set is unknown when the build runs.

```
pnpm build  ->  dist/client   (SPA shell + storefront hydration bundle + manifest)
            ->  dist/server   (entry-server.js, the SSR renderer)
```

Things that follow from that, and will bite if forgotten:

- **The storefront has no client-side router.** Navigation is real `<a href>`,
  search is a real GET form. That is what makes every page crawlable and readable
  before JS, and keeps `react-router` out of a buyer's bundle. Verified by a test
  that drives the store with JavaScript disabled.
- **One round trip per page.** `storefront_home()` and `storefront_product_page()`
  each return the entire page as one jsonb document. Adding a second query to a
  page costs a buyer 150ms of latency, not just a query.
- **The payload is inlined for hydration**, so the client never re-fetches and
  `@supabase/supabase-js` stays out of the storefront bundle. The server talks to
  PostgREST with plain `fetch` (`server/supabase-rpc.ts`).
- **Hydration is deliberately deferred** to idle-after-load, or to the first
  interaction, whichever comes first — see `hydrationBootstrap()`. A
  `type="module"` script does not block paint but the browser still *downloads* it
  at a priority that competes with the LCP image; on the product page that cost
  ~1.3s of LCP. The injected scripts also carry `fetchpriority="low"`, because a
  dynamically created script element otherwise defaults to High.
- **Theme CSS is emitted after the app stylesheet and uses `html:root`.**
  index.css declares the same custom properties on `:root`; equal specificity means
  source order wins, and in dev Vite appends the app CSS at runtime so ours can
  never be last. Getting this wrong renders every store in Selld green with the
  seller's real colour sitting inert in the document.
- **In dev the document must go through `vite.transformIndexHtml()`.** Hand-built
  HTML skips the React Refresh preamble, and the failure is total but silent:
  no preamble → the client module throws → no hydration → and because dev serves
  CSS through the module graph, no styles either.
- **`sizes`/`srcset` constants live in `src/storefront/image-config.ts`.** The
  server's LCP `<link rel="preload">` and the `<img>` must agree; if `imagesizes`
  and `sizes` disagree they can resolve to different candidates and the browser
  downloads both.

## Two authorisation models, not one

Phases 1–5 have exactly one security boundary: `is_tenant_member(tenant_id)`. Phase
6 adds a second, because **a buyer has no account** — nothing to check membership
against. For carts and guest checkout the boundary is the **cart token**: 32 random
bytes in an httpOnly, SameSite=Lax cookie.

What follows from that:

- **`anon` has no table grants on `carts`, `cart_items`, `orders`, `customers`,
  `order_counters`, `sms_logs` or `integration_logs`.** Everything goes through
  `SECURITY DEFINER` functions that validate the token first. A buyer cannot
  `SELECT` their own cart; they call `cart_view(token)`.
- **`carts.token` is not selectable, even by a member.** RLS is row-level, so the
  column list on the grant is the only way to say it — a seller with the token
  could act as the buyer.
- **`apply_reservation()` performs no authorisation.** It holds the sorted advisory
  locks phase 4 introduced, and both `reserve_stock()` (membership) and
  `checkout_place_order()` (cart token) call it. Splitting it that way is what
  keeps guest checkout from reimplementing the deadlock-avoidance logic.
- **`order_receipt(uuid)` is not granted to anon.** Taking an order id alone would
  make the confirmation URL a capability that leaks a name, phone and address to
  anyone it is forwarded to; buyers use `order_receipt_for_token()`.
- **Autofill comes from the buyer's own cookie, never from a phone lookup.** A
  server-side "look up this phone and return the address" endpoint is an address
  disclosure oracle on a public form.

**`cart_pricing()` is the only place money is computed.** The quote the buyer sees
and the order that gets written both go through it, so they cannot disagree.
`cart_items.unit_price_centavos` is a display snapshot and is never charged —
`supabase/tests/tenancy-isolation.sql` rewrites it to 1 centavo and asserts the
order still charges the live price. That assertion was verified to fail when
`cart_pricing` is changed to trust the snapshot.

## Architecture

```
src/
  App.tsx       ← picks a surface by hostname, lazy-loads it
  core/         ← extraction boundary; becomes @yourorg/ph-commerce-core
    couriers/ payments/ sms/ marketplaces/ tenancy/ integration/
  app/          ← dashboard (authenticated seller surface)
  storefront/   ← public buyer surface, own perf budget
  features/     ← feature slices; may import from core and lib
    address/ auth/ catalog/ inventory/ onboarding/ tenancy/
  lib/          ← money, phone, psgc, i18n, time, supabase, tenant
  components/ui ← shadcn/ui primitives
```

**The two surfaces are separate chunks.** `dashboard-app.tsx` and
`storefront-app.tsx` are lazy-loaded, so a buyer on `{slug}.selld.ph` never
downloads auth, tenancy, or the dashboard shell. Keep it that way — the storefront
carries a hard LCP < 2.0s on 3G budget. Adding a dashboard import to
`src/storefront/**` silently spends a buyer's mobile data.

**Provider/context/hook split.** Each of these lives in its own file
(`session-context.ts`, `session-provider.tsx`, `use-session.ts`) because
`react-refresh/only-export-components` requires a module to export components
*or* other things, not both. Follow the pattern for new contexts.

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
- **Auth emails must render `{{ .Token }}`.** Supabase's default templates send a
  magic *link*; Selld's sign-in asks for a *code*. `supabase/config.toml` points
  `magic_link`, `confirmation` and `recovery` at `supabase/templates/otp-code.html`
  — but **config.toml is local only**. On Supabase cloud the same three templates
  must be set under Authentication → Emails or email sign-in silently breaks.
- **New `tenant_settings` keys go in `src/lib/settings/keys.ts` first.** The table
  is key/value, so nothing in the database stops a typo'd key; that file is the
  compensating control, and its parsers make a malformed value fall back to a
  default rather than reach pricing logic as `NaN`.
- **Never require a province.** NCR and 3 independent cities have none. Use
  `isAddressComplete()` and `PhAddressPicker`, which handle it.
- **Denormalised `tenant_id` needs a composite FK, not a trigger.** Give the parent
  `unique (tenant_id, id)` and have the child reference `(tenant_id, parent_id)`.
  Postgres then makes a cross-tenant child unrepresentable — stronger than a policy,
  because it holds even inside a `SECURITY DEFINER` function.
- **Immediate triggers for row validity, deferred ones for cross-row invariants.**
  A `DEFERRABLE INITIALLY DEFERRED` constraint trigger only fires at COMMIT, so it
  cannot report which statement was at fault (and is invisible to a test that rolls
  back). `product_variants` validates immediately; `product_options` re-validates
  its product's variants deferred, because regenerating a matrix is legitimately
  multi-statement.
- **Never write `inventory_levels.on_hand`.** It is a cache of the movement ledger,
  maintained by trigger, and a guard rejects direct writes. Insert a
  `stock_movements` row (or call `record_stock_movement` / `set_stock_level`).
  `sum(delta) = on_hand` is asserted by both DB suites.
- **A guard trigger on a child table must allow the parent's DELETE cascade.** Two
  triggers got this wrong and between them made a tenant undeletable — see
  `20260730000600`. Check whether the parent row still exists: on a cascade it is
  already gone, which cleanly distinguishes "the parent is going away" from
  "someone is editing this row".
- **Take advisory locks in sorted order.** Two carts holding {A,B} and {B,A} and
  locking in arrival order deadlock, and Postgres kills one — a failed checkout for
  a buyer who did nothing wrong. `reserve_stock` sorts; scenario 3 of the
  concurrency test fails if that is removed.
- **Controlled inputs, or bulk edits silently desync.** A `defaultValue` money input
  ignores an external change, so "apply to all" updated state and left twelve
  inputs showing the old price — saved correctly, looked broken.
  `src/features/catalog/variant-grid.test.tsx` guards it. Adjust state from props
  *during render*, never in an effect.
- **`fetchPriority` is React 19. On React 18 use lowercase `fetchpriority`.**
  Same family as the `forwardRef` trap above. `react-dom/server` writes the
  camelCase prop out verbatim and HTML attributes are case-insensitive, so it
  *works* — while `react-dom/client` warns for every image on the page during
  hydration. Use `priorityAttrs()` from `src/storefront/image-config.ts`.
- **i18next plural keys are `_one`/`_other`, never `_plural`.** The `_plural`
  suffix is i18next v3; from v21 the JSON v4 format expects CLDR category
  suffixes. Nothing warns — the lookup just misses and falls back to the
  singular, so `{{count}} items` rendered as "3 item" through two whole phases.
  `src/lib/i18n/plurals.test.ts` guards it. In `tl` both forms carry the same
  text on purpose: Tagalog nouns are not inflected for number, which is also why
  CLDR puts 2 and 3 in tl's `one` category.
- **Server rendering needs `createI18nInstance()`, not `initI18n()`.** The
  singleton's `initialised` guard is right for a browser and wrong for a server:
  the first request's locale would apply to every later one, so one Taglish store
  would render every English store in Taglish until the process restarted.
- **A CHECK constraint may not contain a subquery.** Testing "every element of an
  array satisfies P" needs one, so it goes through an `IMMUTABLE` helper —
  see `image_widths_are_sane()` in `20260730000800`.
- **Read the Vite manifest transitively.** Rollup attributes CSS to the chunk that
  imports it, and because the dashboard and storefront share a vendor chunk,
  Tailwind's sheet lands there rather than on either entry. `manifest[entry].css`
  is empty, and reading only that shipped a completely unstyled storefront that
  still returned 200 with every word of its content present.
- **Cookie `Secure` comes from the request, not from `NODE_ENV`.** Keying it on the
  environment emitted Secure cookies over plain http for `pnpm start`, and every
  client correctly refused to store them — the symptom is not an error but a cart
  that silently stays empty. See `isSecureRequest()`.
- **Everything the SSR renderer needs must be in the inlined hydration state.**
  `cartCount` was passed to the server render but left out of the payload, so the
  client hydrated with 0, the badge `<span>` did not match, and React discarded the
  entire server-rendered tree and re-rendered — silently undoing the phase 5 perf
  work. Hydration warnings on this surface are load-bearing, not cosmetic.
- **A write blocked by a missing GRANT raises; a write blocked by RLS does not.**
  The zero-rows rule above only applies to policy denial. `orders` has no DELETE
  grant, so `delete from orders` raises 42501 — assert with `tests.rejects`, not
  `tests.affected`.
- **The peso sign doubles every SMS.** `₱` is absent from GSM-7, so one character
  forces the whole message to UCS-2 and halves the per-segment budget from 160 to
  70. Write `PHP 229.00` in anything that goes out over SMS;
  `src/core/sms/log-provider.test.ts` guards it.
- **A JSONB address snapshot has no foreign keys.** "Non-empty" accepted a region
  code posted into the city field and produced an order no courier could deliver.
  `checkout_place_order` verifies the codes exist in PSGC *and* belong to each
  other.
- **`t()` keys must stay literal types.** A `Record<number, \`onboarding.${string}\`>`
  lookup compiles but loses key checking; use `as const` arrays/objects so the
  literal survives.
- **A PostgREST error is not an `Error`.** On the ordinary
  `const { error } = await client.from(…)` path, postgrest-js does
  `error = JSON.parse(body)` and returns a **plain object** — it only constructs its
  `PostgrestError` class (which does extend `Error`) under `.throwOnError()`. So
  `if (!(error instanceof Error)) return fallback` in front of a message matcher
  returns the fallback for *every* database failure. Nothing crashes: the seller
  just gets "please try again" for a duplicate they have to go and remove, forever.
  Use `errorMessage()` from `src/lib/supabase/errors.ts`. This shipped twice — in
  `describeStockError` and `describeShippingError` — because a test that builds
  `new Error(realMessage)` passes happily. Model the error as a plain object.
- **Never run `prettier` on this repo.** There is no prettier config and no prettier
  dependency; style is convention (no semicolons, single quotes) and eslint does not
  enforce either. `npx prettier --write` silently reformats a file to prettier's
  defaults and eslint reports nothing wrong.
- **A fixture must not encode the answer it is checking.** The phase-7 zone fixture
  numbered `sort_order` 0/1/2 in specificity order, so `order by sort_order` alone
  produced the right zone and all ten resolver assertions passed against a resolver
  with the specificity tiebreak deleted. It now numbers them backwards on purpose.
  Same lesson as the phase-6 hard-rule-6 assertion: after writing a test, break the
  thing it guards and watch it fail.
- **`revoke ... from anon, authenticated` does not lock down a function.** Postgres
  grants `EXECUTE` on every new function to **PUBLIC**, and revoking from a specific
  role does not remove a privilege that role holds *through* PUBLIC. The revoke
  succeeds, changes nothing, and reports no error. `record_payment_event` — the
  function that marks orders paid — shipped callable by `anon` this way. Always
  `revoke all on function … from public;`. `\dp` shows the tell: `=X/postgres`, where
  the empty grantee is PUBLIC. A CI step asserts the ACL for every money-moving
  function so a new one cannot repeat it.
- **A `security_invoker` view cannot read a column its caller has no grant on.**
  `payment_accounts_safe` exists precisely to derive facts (`has_secret_key`,
  `secret_key_last4`) from columns with no SELECT grant, so under invoker's rights it
  failed for every caller with "permission denied for table payment_accounts". It is
  owner-run with `is_tenant_member()` in the `where` clause instead — the same
  pattern as the `storefront_*` views.
- **`pnpm db:types` used to drop the file's hand-written header**, which CI's drift
  check strips with `tail -n +10`. Running it therefore broke the check it exists to
  satisfy. The script now re-emits the header.
- **`pnpm db:test` does not apply migrations.** It runs the SQL suites against
  whatever is already in the database, so editing a migration and re-running the
  tests proves nothing about the edit. Sabotage a function with
  `create or replace` over the live database, or `pnpm db:reset` first.

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
