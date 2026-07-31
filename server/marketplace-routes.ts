import type { IncomingMessage, ServerResponse } from 'node:http'

import { marketplaceRegistry } from '@/core/marketplaces'
import { createLazadaProvider } from '@/core/marketplaces/lazada-provider'
import { createShopeeProvider } from '@/core/marketplaces/shopee-provider'
import type {
  MarketplaceCredentials,
  MarketplaceProvider,
  StockPush,
} from '@/core/marketplaces/types'

import { readServiceConfig } from './payment-webhook'
import { readSupabaseConfig, rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Marketplace sync: the half Postgres cannot do.
 *
 * Every rule this file looks like it enforces is enforced on the other side of
 * two calls. `marketplace_push_claim` decides *what* to push and *how much*;
 * `marketplace_push_record` decides what a failure costs and when it is worth
 * telling the seller. What is left here is calling somebody else's HTTP API,
 * which is the one thing the database cannot do.
 *
 * ## The stopwatch
 *
 * The done-when is "selling the last unit on the storefront zeroes the Shopee
 * listing within 60 seconds", and the chain is:
 *
 *   checkout reserves      →  `inventory_levels.reserved` rises
 *   trigger                →  a queue row, due 2s out
 *   this worker (every 2s) →  claim, push, record
 *
 * So the budget is roughly 2s of coalescing plus one poll interval plus one
 * round trip to Shopee — a few seconds, against a minute. The margin is
 * deliberate: the interval is the thing most likely to be raised by an operator
 * who thinks it is chatty, and it can go to 20s before the deadline is at risk.
 */

const MARKETPLACE_SYNC_PATH = /^\/api\/marketplace\/([0-9a-f-]{36})\/(import|pull|push)$/i

/** How often the worker looks for due pushes. See the budget above. */
export const PUSH_POLL_MS = 2_000

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/**
 * Register the implementations at startup, never at import time, so tests can
 * install fakes — the same rule the courier, SMS and messaging registries follow.
 *
 * A marketplace with no partner credentials configured is simply not registered.
 * Registering a provider that cannot authenticate would turn "this server is not
 * set up for Shopee" into a queue of auth failures.
 */
export function registerMarketplaceProviders(env: NodeJS.ProcessEnv = process.env): void {
  const shopeeBase = env.SHOPEE_API_BASE_URL
  if (
    marketplaceRegistry.find('shopee') === undefined &&
    shopeeBase !== undefined &&
    env.SHOPEE_PARTNER_ID !== undefined &&
    env.SHOPEE_PARTNER_KEY !== undefined
  ) {
    marketplaceRegistry.register(
      createShopeeProvider({
        baseUrl: shopeeBase,
        partnerId: env.SHOPEE_PARTNER_ID,
        partnerKey: env.SHOPEE_PARTNER_KEY,
      }),
    )
  }

  const lazadaBase = env.LAZADA_API_BASE_URL
  if (
    marketplaceRegistry.find('lazada') === undefined &&
    lazadaBase !== undefined &&
    env.LAZADA_APP_KEY !== undefined &&
    env.LAZADA_APP_SECRET !== undefined
  ) {
    marketplaceRegistry.register(
      createLazadaProvider({
        baseUrl: lazadaBase,
        appKey: env.LAZADA_APP_KEY,
        appSecret: env.LAZADA_APP_SECRET,
      }),
    )
  }
}

function credentialsKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.MARKETPLACE_CREDENTIALS_KEY ?? env.COURIER_CREDENTIALS_KEY
  return key === undefined || key.trim() === '' ? null : key.trim()
}

interface Claim {
  listingId: string
  tenantId: string
  connectionId: string
  platform: 'shopee' | 'lazada' | 'tiktok'
  shopId: string
  externalItemId: string
  externalVariationId: string | null
  externalSku: string | null
  variantId: string | null
  attempts: number
  onHand: number | null
}

async function credentialsFor(
  service: SupabaseConfig,
  connectionId: string,
  shopId: string,
  key: string,
): Promise<MarketplaceCredentials | null> {
  const stored = await rpc<Record<string, unknown> | null>(
    service,
    'marketplace_credentials',
    { p_connection_id: connectionId, p_key: key },
  ).catch(() => null)
  if (stored === null) return null
  const accessToken = String(stored.accessToken ?? '')
  if (accessToken === '') return null
  const refreshToken = stored.refreshToken
  return {
    shopId,
    accessToken,
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
  }
}

/**
 * Drain the due stock pushes once.
 *
 * Exported so the proof drives exactly this function rather than a copy of it.
 * Grouped by connection because one call per listing is what a rate limit is
 * for, and because both providers batch by item internally.
 */
export async function drainStockPushes(
  service: SupabaseConfig,
  limit = 200,
): Promise<{ pushed: number; failed: number; skipped: number }> {
  const key = credentialsKey()
  if (key === null) return { pushed: 0, failed: 0, skipped: 0 }

  const claims = await rpc<Claim[]>(service, 'marketplace_push_claim', { p_limit: limit })
  if (claims.length === 0) return { pushed: 0, failed: 0, skipped: 0 }

  let pushed = 0
  let failed = 0
  let skipped = 0

  // Group by connection: one shop, one set of credentials, one batch.
  const byConnection = new Map<string, Claim[]>()
  for (const claim of claims) {
    const existing = byConnection.get(claim.connectionId)
    if (existing === undefined) byConnection.set(claim.connectionId, [claim])
    else existing.push(claim)
  }

  for (const [connectionId, group] of byConnection) {
    // A listing nobody has mapped has no number to send. It is reported rather
    // than dropped, so it shows up as work on the marketplace screen instead of
    // as a listing that quietly stopped being kept in step.
    const unmapped = group.filter((claim) => claim.onHand === null)
    for (const claim of unmapped) {
      skipped += 1
      await rpc(service, 'marketplace_push_record', {
        p_listing_id: claim.listingId,
        p_status: 'unmapped',
        p_stock: null,
        p_error: null,
        p_attempts: claim.attempts,
      }).catch(() => {})
    }

    const mapped = group.filter((claim) => claim.onHand !== null)
    if (mapped.length === 0) continue

    const first = mapped[0] as Claim
    const provider: MarketplaceProvider | undefined = marketplaceRegistry.find(first.platform)
    const credentials =
      provider === undefined
        ? null
        : await credentialsFor(service, connectionId, first.shopId, key)

    if (provider === undefined || credentials === null) {
      // No provider configured on this server, or no usable token. Both are
      // failures of *setup*, not of the listing, so they are recorded as
      // failures (which back off) rather than as unmapped.
      for (const claim of mapped) {
        failed += 1
        await rpc(service, 'marketplace_push_record', {
          p_listing_id: claim.listingId,
          p_status: 'failed',
          p_stock: claim.onHand,
          p_error: provider === undefined ? 'no_provider' : 'no_credentials',
          p_attempts: claim.attempts,
        }).catch(() => {})
      }
      continue
    }

    const updates: StockPush[] = mapped.map((claim) => ({
      externalItemId: claim.externalItemId,
      ...(claim.externalVariationId === null
        ? {}
        : { externalVariationId: claim.externalVariationId }),
      onHand: claim.onHand ?? 0,
    }))

    let results
    try {
      results = await provider.pushStock(credentials, updates)
    } catch (cause) {
      // `pushStock` catches per item, so reaching here means the whole call
      // failed — a network partition, or credentials the provider rejected
      // before it got as far as an item.
      const message = cause instanceof Error ? cause.message : String(cause)
      for (const claim of mapped) {
        failed += 1
        await rpc(service, 'marketplace_push_record', {
          p_listing_id: claim.listingId,
          p_status: 'failed',
          p_stock: claim.onHand,
          p_error: message,
          p_attempts: claim.attempts,
        }).catch(() => {})
      }
      continue
    }

    for (const claim of mapped) {
      const result = results.find(
        (r) =>
          r.externalItemId === claim.externalItemId &&
          (r.externalVariationId ?? null) === claim.externalVariationId,
      )
      const ok = result?.ok === true
      if (ok) pushed += 1
      else failed += 1
      await rpc(service, 'marketplace_push_record', {
        p_listing_id: claim.listingId,
        p_status: ok ? 'ok' : 'failed',
        p_stock: claim.onHand,
        p_error: ok ? null : (result?.error ?? 'no_result'),
        p_attempts: claim.attempts,
      }).catch(() => {})
    }
  }

  return { pushed, failed, skipped }
}

/**
 * Pull orders for every connection that wants them.
 *
 * The cursor is the connection's `last_order_pull_at`, and `marketplace_order_ingest`
 * is idempotent on the marketplace's own order id — which is what makes an
 * overlapping window safe. Overlap is not sloppiness: a marketplace's clock is
 * not ours, and a cursor that excludes the boundary loses the order that landed
 * on it.
 */
export async function pullMarketplaceOrders(
  service: SupabaseConfig,
): Promise<{ pulled: number; created: number }> {
  const key = credentialsKey()
  if (key === null) return { pulled: 0, created: 0 }

  const connections = await rpc<
    { id: string; tenantId: string; platform: 'shopee' | 'lazada' | 'tiktok'; shopId: string; since: string }[]
  >(service, 'marketplace_connections_due', {})

  let pulled = 0
  let created = 0

  for (const connection of connections) {
    const provider = marketplaceRegistry.find(connection.platform)
    if (provider === undefined) continue
    const credentials = await credentialsFor(service, connection.id, connection.shopId, key)
    if (credentials === null) continue

    let orders
    try {
      // Sixty seconds of overlap, for the clock skew above.
      const since = new Date(new Date(connection.since).getTime() - 60_000)
      orders = await provider.pullOrders(credentials, since)
    } catch {
      continue
    }

    for (const order of orders) {
      pulled += 1
      const result = await rpc<{ created: boolean } | null>(
        service,
        'marketplace_order_ingest',
        {
          p_connection_id: connection.id,
          p_order: {
            ...order,
            placedAt: order.placedAt.toISOString(),
          },
        },
      ).catch(() => null)
      if (result?.created === true) created += 1
    }
  }

  return { pulled, created }
}

/**
 * The background loop.
 *
 * Returns a stop function rather than running forever, so a test can start it,
 * measure, and shut it down — and so the process can exit.
 */
export function startMarketplaceWorker(
  service: SupabaseConfig,
  options: { pushIntervalMs?: number; pullIntervalMs?: number } = {},
): () => void {
  const pushInterval = options.pushIntervalMs ?? PUSH_POLL_MS
  // Orders are pulled far less often: a marketplace order is not urgent the way
  // a stock number is — nobody oversells because an order appeared a minute
  // late — and a polling loop is the seller's rate limit being spent.
  const pullInterval = options.pullIntervalMs ?? 60_000

  let pushing = false
  let pulling = false

  const push = setInterval(() => {
    if (pushing) return
    pushing = true
    void drainStockPushes(service)
      .catch(() => {})
      .finally(() => {
        pushing = false
      })
  }, pushInterval)

  const pull = setInterval(() => {
    if (pulling) return
    pulling = true
    void pullMarketplaceOrders(service)
      .catch(() => {})
      .finally(() => {
        pulling = false
      })
  }, pullInterval)

  // Do not hold the process open on their account.
  push.unref?.()
  pull.unref?.()

  return () => {
    clearInterval(push)
    clearInterval(pull)
  }
}

/**
 * `POST /api/marketplace/{connectionId}/{import|pull|push}`
 *
 * Authorisation is the database's, in two steps: the caller's own token has to
 * be able to see the connection through `marketplace_connections_safe`, and the
 * functions it then calls check the role themselves. This file checks nothing on
 * its own, which is the point — a second copy of the rule is a second thing to
 * get wrong.
 */
export async function serveMarketplaceRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = MARKETPLACE_SYNC_PATH.exec(url.pathname)
  if (match === null) return false

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const service = readServiceConfig()
  const anon = readSupabaseConfig()
  const key = credentialsKey()
  if (service === null || anon === null || key === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  const jwt = bearer(request)
  const connectionId = match[1] as string
  const action = (match[2] as string).toLowerCase()
  if (jwt === '') {
    send(response, 401, { error: 'unauthenticated' })
    return true
  }

  // Read it as the caller. A JWT for another store sees an empty list rather
  // than somebody else's shop — `marketplace_connections_safe` carries
  // `is_tenant_member` in its WHERE.
  const visible = await fetch(
    `${anon.url}/rest/v1/marketplace_connections_safe?id=eq.${connectionId}&select=id,platform,shop_id`,
    { headers: { apikey: anon.anonKey, Authorization: `Bearer ${jwt}` } },
  )
    .then(async (r) => (r.ok ? ((await r.json()) as { platform: string; shop_id: string }[]) : []))
    .catch(() => [])

  const connection = visible[0]
  if (connection === undefined) {
    send(response, 403, { error: 'not_allowed' })
    return true
  }

  try {
    if (action === 'push') {
      send(response, 200, await drainStockPushes(service))
      return true
    }
    if (action === 'pull') {
      send(response, 200, await pullMarketplaceOrders(service))
      return true
    }

    // import: ask the marketplace what it is selling, and write the mapping table.
    registerMarketplaceProviders()
    const provider = marketplaceRegistry.find(
      connection.platform as 'shopee' | 'lazada' | 'tiktok',
    )
    if (provider === undefined) {
      send(response, 503, { error: 'no_provider' })
      return true
    }
    const credentials = await credentialsFor(service, connectionId, connection.shop_id, key)
    if (credentials === null) {
      send(response, 409, { error: 'no_credentials' })
      return true
    }

    const listings = await provider.listListings(credentials)
    const result = await rpc<{ imported: number; matched: number }>(
      service,
      'marketplace_listings_import',
      { p_connection_id: connectionId, p_listings: listings },
    )
    send(response, 200, result)
  } catch (cause) {
    send(response, 503, {
      error: 'sync_failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    })
  }
  return true
}
