# Selld — Build Spec (21 Phases)

Multi-tenant ecommerce + order operations platform for Philippine social sellers.
This is the master brief. **Build one phase per session. Do not skip ahead.**

Phase status is tracked in [`docs/phase-status.md`](phase-status.md).

---

## 0. Stack & conventions

**Frontend:** React 18 + Vite + TypeScript + Tailwind CSS + shadcn/ui + TanStack Query + React Router
**Backend:** Supabase — Postgres, Auth, Storage, Realtime, Edge Functions (Deno)
**Payments:** Xendit (GCash, Maya, GrabPay, cards, QRPH) + COD
**SMS:** Semaphore (PH A2P). Cost ~₱0.30/msg, retail ₱0.50
**Couriers:** J&T Express, Flash Express, LBC, Ninja Van — behind a provider-agnostic interface
**Social:** Facebook Graph API (page webhooks for comments, Send API for DMs)
**Marketplaces:** Shopee Open Platform, Lazada Open Platform, TikTok Shop Partner API
**Hosting:** Vercel (app + storefront), Supabase cloud
**PWA:** installable, offline-tolerant order list for packing

### Hard rules

- Every tenant-scoped table has `tenant_id uuid not null` and RLS enabled. No exceptions.
- All money is `bigint` in centavos. Never floats. Currency is PHP only for v1.
- All timestamps `timestamptz`, stored UTC, displayed in `Asia/Manila`.
- Mobile-first. The dashboard must be fully usable on a 390px viewport — sellers work from phones.
- Taglish copy support: every user-facing string goes through an i18n layer with `en` and `tl` locales from phase 0.
- Never trust client-side prices. Recompute every cart total server-side at checkout.
- Every external API call is wrapped in an idempotency key + retry with exponential backoff, and logged to `integration_logs`.

### Provider abstraction pattern

Mirrors Servd's `DeliveryProvider`:

```ts
interface CourierProvider {
  id: 'jnt' | 'flash' | 'lbc' | 'ninja'
  quote(input: QuoteInput): Promise<Rate[]>
  book(input: BookInput): Promise<{ waybill: string; labelUrl: string }>
  track(waybill: string): Promise<TrackingEvent[]>
  cancel(waybill: string): Promise<void>
  parseWebhook(payload: unknown): TrackingEvent[]
}
```

Same shape for `PaymentProvider`, `SmsProvider`, `MarketplaceProvider`. **Adding a
courier must never require touching order logic.**

---

## 1. Database schema

### Tenancy & identity

1. `tenants` — store record: name, slug, subdomain, custom_domain, logo, brand colors, status, timezone, locale
2. `tenant_settings` — key/value JSONB: checkout rules, COD policy, order prefix, auto-confirm, packing slip config
3. `tenant_domains` — custom domain verification state, SSL status
4. `profiles` — extends auth.users: full_name, phone, avatar
5. `tenant_members` — tenant_id, user_id, role (`owner` | `admin` | `staff` | `packer` | `rider`), invited_at, accepted_at
6. `invitations` — email, role, token, expires_at
7. `plans` — code, name, price_centavos, limits JSONB (max_orders, max_products, max_users, features[])
8. `subscriptions` — tenant_id, plan_id, status, current_period_end, trial_end, cancel_at
9. `subscription_invoices` — amount, status, xendit_invoice_id, paid_at
10. `sms_credit_ledger` — tenant_id, delta, reason, balance_after

### Catalog

11. `categories` — tenant_id, name, slug, parent_id, sort_order
12. `products` — tenant_id, name, slug, description, status (`draft`|`active`|`archived`), category_id, is_cod_allowed, weight_grams, dimensions
13. `product_options` — product_id, name (Size, Color), sort_order
14. `product_option_values` — option_id, value, sort_order
15. `product_variants` — product_id, sku, barcode, price_centavos, compare_at_price_centavos, cost_centavos, weight_grams, option_value_ids[]
16. `product_images` — product_id, variant_id (nullable), storage_path, alt, sort_order
17. `media_assets` — tenant_id, storage_path, mime, size, width, height

### Inventory

18. `locations` — tenant_id, name, address, is_default, type (`warehouse`|`home`|`consignment`)
19. `inventory_levels` — variant_id, location_id, on_hand, reserved, incoming (unique on variant+location)
20. `stock_movements` — variant_id, location_id, delta, reason (`sale`|`return`|`adjustment`|`transfer`|`rts`|`damage`), reference_type, reference_id, note, created_by
21. `stock_transfers` + 22. `stock_transfer_items` — between locations

### Customers

23. `customers` — tenant_id, name, phone (indexed, PH-normalized to +63), email, fb_psid, source, total_orders, total_spent_centavos, notes
24. `customer_addresses` — customer_id, label, recipient, phone, region, province, city, barangay, street, postal_code, landmark, is_default
25. `customer_tags` + 26. `customer_tag_assignments`
27. `buyer_risk_flags` — phone, tenant_id (nullable = platform-wide), flag_type (`rts_repeat`|`fake_order`|`chargeback`|`blocked`), score, evidence JSONB, created_by

### Orders & checkout

28. `carts` — tenant_id, token, customer_id (nullable), status, expires_at, source (`storefront`|`live`|`manual`|`marketplace`)
29. `cart_items` — cart_id, variant_id, qty, unit_price_centavos snapshot
30. `orders` — tenant_id, order_number (per-tenant sequence, prefix from settings), customer_id, shipping_address JSONB snapshot, subtotal, discount_total, shipping_total, cod_fee, grand_total (all centavos), payment_method (`cod`|`gcash`|`maya`|`card`|`bank`|`qrph`), payment_status (`unpaid`|`paid`|`partial`|`refunded`), fulfillment_status (`pending`|`confirmed`|`packed`|`shipped`|`delivered`|`rts`|`cancelled`), source, channel_ref (marketplace order id), notes, cancelled_reason
31. `order_items` — order_id, variant_id, product_name + variant_label snapshots, qty, unit_price_centavos, cost_centavos snapshot, line_total
32. `order_status_history` — order_id, from_status, to_status, actor_id, note, created_at
33. `order_notes` — internal comments thread per order

### Discounts

34. `discounts` — tenant_id, code, type (`percent`|`fixed`|`free_shipping`), value, min_subtotal, usage_limit, usage_limit_per_customer, starts_at, ends_at, applies_to JSONB, is_auto
35. `discount_redemptions` — discount_id, order_id, customer_id

### Payments

36. `payments` — order_id, provider, provider_ref, method, amount_centavos, fee_centavos, status, raw_payload JSONB, paid_at
37. `refunds` — payment_id, amount_centavos, reason, status, provider_ref

### Shipping & fulfillment

38. `shipping_zones` — tenant_id, name, match_rules JSONB (region/province/city lists)
39. `shipping_rates` — zone_id, name, type (`flat`|`weight_tiered`|`courier_live`|`free_over`), config JSONB
40. `courier_accounts` — tenant_id, provider, credentials (encrypted), account_ref, is_active, default_service
41. `shipments` — order_id, courier_account_id, waybill, service, label_url, declared_value, cod_amount_centavos, status, booked_at, shipped_at, delivered_at
42. `shipment_events` — shipment_id, code, description, location, occurred_at, raw JSONB
43. `cod_remittances` — tenant_id, courier_account_id, reference, expected_centavos, received_centavos, variance_centavos, period_start, period_end, status, statement_url
44. `cod_remittance_items` — remittance_id, shipment_id, amount_centavos, matched (bool)

### Live selling & messaging

45. `live_sessions` — tenant_id, platform (`facebook`|`tiktok`|`instagram`), external_post_id, title, started_at, ended_at, claim_window_minutes, status
46. `live_session_items` — live_session_id, variant_id, claim_code (e.g. "A1"), announced_price_centavos, qty_available, qty_claimed
47. `live_claims` — live_session_id, live_session_item_id, platform_comment_id, commenter_name, commenter_psid, raw_comment, parsed_qty, status (`pending`|`link_sent`|`converted`|`expired`|`rejected`), cart_id, order_id, claimed_at
48. `social_accounts` — tenant_id, platform, page_id, page_name, access_token (encrypted), webhook_verified, scopes[]
49. `message_threads` — tenant_id, platform, psid, customer_id, last_message_at, unread_count
50. `messages` — thread_id, direction, body, attachments JSONB, platform_message_id, sent_at
51. `broadcasts` — tenant_id, channel (`sms`|`messenger`), name, segment_definition JSONB, body, scheduled_at, status, sent_count, delivered_count, click_count
52. `broadcast_recipients` — broadcast_id, customer_id, channel_address, status, error, sent_at
53. `sms_logs` — tenant_id, to, body, provider_ref, status, cost_centavos, purpose (`tracking`|`otp`|`broadcast`|`abandoned_cart`)
54. `abandoned_carts` — cart_id, recovery_token, reminders_sent, recovered_order_id

### Marketplace sync

55. `marketplace_connections` — tenant_id, platform, shop_id, credentials (encrypted), sync_stock, sync_orders, last_synced_at, status
56. `marketplace_listings` — connection_id, variant_id, external_item_id, external_sku, last_pushed_stock, last_pushed_at
57. `marketplace_sync_logs` — connection_id, direction, entity, status, payload JSONB, error

### Platform

58. `integration_logs` — tenant_id, provider, endpoint, request, response, status_code, duration_ms
59. `webhook_events` — provider, external_id (unique, for idempotency), payload, processed_at, error
60. `audit_logs` — tenant_id, actor_id, action, entity_type, entity_id, before JSONB, after JSONB, ip
61. `notifications` — tenant_id, user_id, type, title, body, entity_ref, read_at
62. `storefront_themes` — tenant_id, preset, colors JSONB, fonts, hero JSONB, custom_css
63. `storefront_pages` — tenant_id, slug, title, body, is_published (About, FAQ, Shipping Policy)
64. `product_reviews` — product_id, customer_id, order_id, rating, body, photos[], status

> Count is 64 tables including junctions — trim `stock_transfers`,
> `product_reviews`, and `storefront_pages` out of v1 if you want to ship faster.

---

## Phase plan

### Phase 0 — Foundation
Vite + React + TS + Tailwind + shadcn/ui scaffold. Supabase project, local dev with `supabase start`. Folder structure: `src/app` (dashboard), `src/storefront`, `src/lib`, `src/features/*`. i18n layer with `en`/`tl`. Money utilities (`centavos.ts`), PH phone normalizer, PSGC region/province/city/barangay dataset seeded as a lookup table. Base migration runner. CI: typecheck + lint + build.
**Done when:** `npm run build` passes, empty dashboard shell renders, locale toggle works.

### Phase 1 — Auth & multi-tenant core
Supabase Auth (email + phone OTP via Semaphore). `tenants`, `profiles`, `tenant_members`, `invitations`. RLS policies with a `current_tenant_id()` helper and role-based policy functions. Tenant switcher. Middleware that resolves tenant from subdomain on the storefront and from session on the dashboard.
**Done when:** two tenants exist and neither can read a single row of the other's data — prove it with SQL tests.

### Phase 2 — Store onboarding wizard
5 steps: store name + subdomain → logo & brand colors → what do you sell (category presets) → shipping origin address → payment methods (COD toggle + Xendit connect). Writes `tenants`, `tenant_settings`, `locations`, `storefront_themes`.
**Done when:** a new signup reaches a live (empty) storefront in under 3 minutes.

### Phase 3 — Catalog
Products, options, option values, variant matrix generator (Size × Color → variants), images with Supabase Storage + client-side resize, categories, bulk CSV import/export, quick-add form optimized for phone. Variant grid editor for price/SKU/stock inline.
**Done when:** a 3-option product with 12 variants can be created on a phone in under 2 minutes.

### Phase 4 — Inventory
`locations`, `inventory_levels`, `stock_movements`. Reserve-on-order, release-on-cancel, deduct-on-ship. Low-stock thresholds + alerts. Stock adjustment UI with reason codes. Movement ledger view per variant. Oversell prevention as a Postgres constraint + advisory lock, not application logic.
**Done when:** two concurrent checkouts for the last unit — exactly one succeeds.

### Phase 5 — Storefront
Public store at `{slug}.selld.ph` and custom domains. SSR or prerender for speed (target LCP < 2.0s on 3G). Product listing, filters, product detail with variant picker, image gallery, stock display, search. Theme driven by `storefront_themes`. Mobile-first, thumb-reachable add-to-cart. OG image generation per product.
**Done when:** Lighthouse mobile performance ≥ 90 and the store looks legitimately branded, not templated.

### Phase 6 — Cart & guest checkout
Cart via token cookie, no account required. Checkout: contact (name + phone, email optional) → PSGC cascading address picker with barangay + landmark → shipping method → payment method → review. Server-side total recomputation. Order confirmation page + SMS. Autofill for returning phone numbers.
**Done when:** a full checkout takes under 60 seconds on mobile with 5 taps of typing or less.

### Phase 7 — Shipping configuration
Zones by region/province/city. Rate types: flat, weight-tiered, free-over-threshold, live courier quote. Metro Manila vs provincial defaults preset. COD fee configuration (flat or % of order). Per-product COD block.
**Done when:** a seller can express "₱80 Davao City, ₱150 Mindanao, ₱200 rest of PH, free over ₱2,000" without touching code.

### Phase 8 — Payments
Xendit integration: invoices, GCash, Maya, GrabPay, QRPH, cards. Webhook handler with signature verification + `webhook_events` idempotency. COD flow (order confirmed, payment pending until remittance). Manual payment recording (bank transfer, GCash screenshot upload with proof attachment). Refunds.
**Done when:** a GCash payment moves the order to `paid` via webhook with no polling, and replaying the same webhook twice changes nothing.

### Phase 9 — Order management dashboard
The core screen. Order list with saved views (Needs confirmation / To pack / To ship / In transit / RTS / Today's COD). Bulk actions. Order detail: items, customer, address, timeline, payment, shipment, internal notes. Manual order creation (for DM orders). Status pipeline with `order_status_history` on every transition. Packing slip + picking list PDF (batch print). Order search by phone, name, order number, waybill.
**Done when:** 50 orders can be moved from `confirmed` to `packed` in under 60 seconds.

### Phase 10 — Courier integration
Implement `CourierProvider` for J&T and Flash first. `courier_accounts` with encrypted credentials. Bulk booking: select 40 orders → one click → waybills generated → labels merged into a single printable PDF. Rate quoting at checkout for `courier_live` rates. Booking failure queue with retry.
**Done when:** 40 orders are booked and one PDF of 40 labels downloads in under 30 seconds.

### Phase 11 — Tracking & buyer notifications
Courier webhooks + polling fallback into `shipment_events`. Status mapping to order fulfillment status. Automated SMS at: order confirmed, shipped (with waybill + tracking link), out for delivery, delivered, RTS. Public tracking page at `/track/{order_number}` — no login. SMS templates editable per tenant, in Taglish. Credit ledger deduction.
**Done when:** the "nasaan na po order ko" message volume is structurally eliminated — buyer gets the answer before they ask.

### Phase 12 — COD reconciliation & RTS control
Remittance statement import (CSV/XLSX per courier format) → auto-match to shipments → variance report. RTS recording with automatic stock return movement + cost attribution. `buyer_risk_flags` with an RTS-rate score per phone number; checkout warning + optional COD block for flagged numbers. Cross-tenant risk signal (opt-in, anonymized — this becomes a real network moat).
**Done when:** a seller can answer "how much COD is the courier still holding, and which parcels are unaccounted for" in one screen.

### Phase 13 — Live selling capture
The wedge feature. `live_sessions`: seller creates a session, assigns claim codes (A1, A2...) to variants, sets a claim window. Facebook Live/post comment webhook streams in. Parser extracts claim code + qty from messy Taglish comments ("mine po A1 2pcs", "A1 mine", "sakin yung a1"). Each valid claim → reserve stock → auto-DM a prefilled checkout link via Send API → expire if unpaid within window → release stock. Live operator console: realtime claim feed, manual approve/reject, running total, sold-out auto-announce. Parser must handle: case variance, Bisaya/Tagalog variants, quantity words ("dalawa", "2x", "two"), multiple claims in one comment, duplicate comments from the same PSID.
**Done when:** a 200-comment live session produces correct orders with zero manual encoding, and a dry-run replay of a real comment log scores ≥95% parse accuracy.

### Phase 14 — Messenger & social integration
`social_accounts` OAuth for FB Pages + IG. Unified inbox (`message_threads`, `messages`) with realtime. Keyword auto-replies ("PRICE", "STORE", "ORDER" → store link). Comment auto-reply with private DM (the classic "check your inbox" play). Customer auto-linking by PSID. 24-hour messaging window compliance + message tag handling.
**Done when:** a comment on any post triggers a DM with the store link within 5 seconds.

### Phase 15 — Customers & CRM
Customer profiles with full order history, lifetime value, RTS rate, tags. Segment builder: last purchase date, total spent, product bought, city, order count, RTS status. Import from CSV / Shopee & Lazada order exports. Merge duplicates by phone.
**Done when:** "customers who bought skincare, spent over ₱2,000, haven't ordered in 60 days, zero RTS" is a saved segment.

### Phase 16 — Broadcasts, vouchers & abandoned cart
`broadcasts` over SMS and Messenger with segment targeting, scheduling, per-message cost preview, and delivery reporting. Short-link click tracking. `discounts` engine: codes, auto-discounts, per-customer limits, free shipping. Abandoned cart recovery: 1h / 24h / 72h sequence with recovery token and optional escalating voucher. Repeat-buyer automation (post-delivery thank you + reorder nudge at product-specific intervals).
**Done when:** a payday broadcast to 800 segmented customers sends with cost shown upfront and revenue attribution shown after.

### Phase 17 — Marketplace sync
Implement `MarketplaceProvider` for Shopee and Lazada first, TikTok Shop second. Product/SKU mapping UI. One-way stock push (Selld is source of truth) with debounced sync on every movement. Order pull into `orders` with `source='marketplace'` so all fulfillment happens in one place. Conflict and mapping-error queue.
**Done when:** selling the last unit on the Selld storefront zeroes the Shopee listing within 60 seconds.

### Phase 18 — Analytics & true profit
Dashboard: revenue, orders, AOV, units, by channel, by product, by city. True profit view: revenue − COGS − shipping actual − COD fees − payment fees − ad spend (manual entry or Meta API) − Selld subscription. Commission savings counter ("you've kept ₱X this month vs marketplace fees") — this is retention gold, show it on the home screen. Cohort repeat-purchase rate. RTS rate trend. Best/worst products by margin, not revenue.
**Done when:** the seller can answer "kumita ba ako this month, at magkano talaga" in one glance.

### Phase 19 — Billing, super admin & white-label
Plan enforcement (order/product/user limits, feature gates) at the API layer, not just UI. Xendit recurring subscriptions + dunning. SMS credit purchase. Super admin: tenant list, MRR, churn, usage, impersonation with audit trail, manual plan override, announcement banners. White-label/reseller tier: reseller accounts that own sub-tenants, custom branding, reseller-set pricing, revenue split reporting.
**Done when:** a reseller can onboard and bill their own seller without you touching anything.

### Phase 20 — Hardening & launch
PWA (installable, offline order list for packers). Rate limiting on public endpoints. Encrypted credential storage review. RLS penetration test per table. Data Privacy Act compliance: privacy policy, consent capture at checkout, data export, deletion request flow, breach log. Error tracking (Sentry). Load test checkout and live-claim ingestion at 100 req/s. Seed demo tenant. Onboarding tour. Help docs in Taglish.
**Done when:** a fresh signup can go live and process a real paid order with zero support contact.

---

## Build order logic

Phases 0–9 are a complete sellable product: storefront + orders + inventory +
payments. **Ship it. Charge for it.**

Phases 10–11 (courier + tracking automation) is what makes it sticky — that's the
daily time saved. Phases 12–13 (COD control + live selling) is what makes it
unbeatable locally — no competitor has these. Everything after 13 is expansion
revenue.

**MVP for first paying customers: phase 0 → 11.** Do not build marketplace sync
(17) before you have 10 paying sellers asking for it.

---

## Open decisions

| # | Decision | Status |
|---|---|---|
| 1 | **Codebase relationship to Servd** — shared monorepo vs separate app | **Resolved (phase 0):** standalone app, with `src/core/` as a clean extraction boundary for tenancy / payments / SMS / couriers. Lifts into `@yourorg/ph-commerce-core` later without rewriting call sites; release cycles stay decoupled. |
| 2 | **Live selling comment ingestion** — FB webhooks for live video comments have real API limitations | **Open.** Validate access with a test page before phase 13, and design a manual paste-a-comment-log fallback as a guaranteed backup path. |
| 3 | **Cross-tenant buyer risk network** — big differentiator, needs a clean legal basis under the Data Privacy Act | **Open.** Get reviewed before shipping phase 12's shared signal. |
| 4 | **Domain and name** | **Open.** Lock `selld.ph` plus the storefront wildcard subdomain before phase 5. |
