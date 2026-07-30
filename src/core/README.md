# `src/core` — the extraction boundary

This directory is the code that will eventually become
`@yourorg/ph-commerce-core`, shared with Servd. It is kept clean of Selld
specifics from day one so the extraction is a `git mv`, not a rewrite.

## Rules

1. **Nothing in `src/core` may import from `src/app`, `src/storefront`, or
   `src/features`.** Dependencies point inward only. The CI lint step should be
   extended with an import-boundary rule the moment this is more than a
   convention.
2. **No React.** Core is platform-agnostic TypeScript. Hooks and components that
   consume it live in `src/features/*`.
3. **No direct Supabase table access.** Core defines interfaces and pure logic;
   persistence is injected by the caller. This is what lets Servd reuse it
   against a different schema.
4. **Providers are interfaces first.** Adding a fifth courier must never require
   touching order logic — if it does, the abstraction is wrong.

## Contents

| Path | What it owns |
|---|---|
| `couriers/` | `CourierProvider` — quote, book, track, cancel, parse webhook |
| `payments/` | `PaymentProvider` — charge intents, webhooks, refunds |
| `sms/` | `SmsProvider` — send, delivery receipts, cost reporting |
| `marketplaces/` | `MarketplaceProvider` — stock push, order pull |
| `integration/` | Retry, backoff, idempotency keys, structured call logging |
| `money.ts` | Re-export of the centavos primitives core logic depends on |

## Why the provider registry is generic

Every provider family has the same lifecycle: register implementations at
startup, resolve one by id at call time, and fail loudly on an unknown id.
`integration/registry.ts` implements that once so the four families stay
consistent and adding a fifth is trivial.
