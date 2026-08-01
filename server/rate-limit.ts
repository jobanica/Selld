import type { IncomingMessage, ServerResponse } from 'node:http'

import { readServiceConfig } from './payment-webhook'
import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Rate limiting for the endpoints anyone can reach.
 *
 * ## Why the counters are in Postgres
 *
 * There is more than one Node process, and there will be more than one machine.
 * An in-memory counter is per-process, so the real limit is `limit × processes`
 * and it resets on every deploy — which is to say it is not a limit, it is a
 * comment. `rate_limit_hit()` floors the clock to the window so every process
 * agrees which bucket "now" belongs to without coordinating.
 *
 * ## Why it fails open
 *
 * `check()` returns `allowed: true` on *any* error — no service role configured,
 * database unreachable, timeout. That is deliberate and it is the whole of the
 * risk posture: the thing this protects against is abuse, and the thing failing
 * closed would cause is every buyer of every store being unable to check out
 * because our counter table was briefly unavailable. Abuse is recoverable; a
 * storefront that returns 429 to real customers during an incident is the seller
 * losing a day's sales because of our infrastructure.
 *
 * The timeout is short for the same reason. A limiter that adds 5s to a request
 * before allowing it has already done more damage than the request it was
 * checking.
 *
 * ## Keys
 *
 * A bucket is composed by the caller from whatever the attacker cannot cheaply
 * vary. That is rarely the IP alone — a mobile network hands one address to a
 * whole city, so an IP-only limit on checkout would throttle a barangay because
 * one person was hammering it. Where there is a better key (a cart token, an
 * order number, a webhook slug) it is used, and the IP is the fallback for the
 * paths that have nothing else.
 */

/** What each public path may do, and how often. */
export const LIMITS = {
  /** Placing an order. Per cart, because a cart is one buyer. */
  checkout: { limit: 12, windowSeconds: 60 },
  /** Changing a cart. Generous: a buyer editing quantities taps a lot. */
  cart: { limit: 90, windowSeconds: 60 },
  /**
   * Reading a store. Per IP, and deliberately high — this is the number a
   * shared mobile gateway has to fit under, not the number one buyer needs.
   */
  storefront: { limit: 600, windowSeconds: 60 },
  /**
   * The public tracking page. Per order number, which is the capability being
   * used — an attacker enumerating order numbers gets a fresh bucket each time
   * and is caught by the IP limit underneath instead.
   */
  tracking: { limit: 60, windowSeconds: 60 },
  /** Following a short link. Per slug. */
  shortLink: { limit: 120, windowSeconds: 60 },
  /**
   * Webhooks. Per account slug, high enough that a legitimate burst — a courier
   * pushing 300 scans after an outage — is not refused, low enough that an
   * unauthenticated flood does not become a write amplifier against Postgres.
   */
  webhook: { limit: 600, windowSeconds: 60 },
  /**
   * Live comments, which are the one inbound stream that is *supposed* to burst.
   *
   * The first version of this file gave live selling the same 600/min as every
   * other webhook, and the load test found it immediately: at the 100 req/s the
   * build spec asks for, half the comments came back 429. A rate limit set below
   * the throughput of the feature it protects is not a safety margin, it is the
   * feature switched off under load — and the load in question is a seller's best
   * hour of the week.
   *
   * 6,000 a minute is 100 a second sustained, with the per-address floor still
   * underneath it.
   */
  liveWebhook: { limit: 6_000, windowSeconds: 60 },
} as const

export type LimitName = keyof typeof LIMITS

export interface RateDecision {
  allowed: boolean
  retryAfter: number
}

const ALLOW: RateDecision = { allowed: true, retryAfter: 0 }

/**
 * The caller's address, as well as it can be known.
 *
 * `x-forwarded-for` is a list appended to by every hop, so the *first* entry is
 * the client as the nearest proxy saw it. Trusting the last would let a caller
 * name their own address by sending the header themselves.
 *
 * This is not a security boundary and is not treated as one — it is a bucket key
 * that makes casual abuse cost something.
 */
export function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (first !== undefined && first.trim() !== '') {
    return (first.split(',')[0] ?? '').trim() || 'unknown'
  }
  return request.socket.remoteAddress ?? 'unknown'
}

/**
 * Count one hit against a bucket.
 *
 * `service` is read at call time rather than at import, so a deployment with no
 * service role runs unlimited rather than failing to boot — same reasoning as
 * every other optional capability on this server.
 */
export async function check(
  name: LimitName,
  key: string,
  service: SupabaseConfig | null = readServiceConfig(),
): Promise<RateDecision> {
  if (service === null) return ALLOW

  const { limit, windowSeconds } = LIMITS[name]
  try {
    const result = await rpc<{ allowed: boolean; retryAfter: number }>(
      service,
      'rate_limit_hit',
      { p_bucket: `${name}:${key}`, p_limit: limit, p_window_seconds: windowSeconds },
      // Deliberately short. See the note at the top: a slow limiter has already
      // cost more than the request it is checking.
      { timeoutMs: 1_000 },
    )
    return { allowed: result.allowed, retryAfter: result.retryAfter }
  } catch {
    return ALLOW
  }
}

/**
 * Answer 429 and say when to come back.
 *
 * `Retry-After` is not decoration: it is what makes a well-behaved provider
 * redeliver a webhook rather than drop it, and what stops a browser from
 * hammering. A 429 without it invites the caller to guess, and they guess "now".
 */
export function tooMany(response: ServerResponse, retryAfter: number, body?: string): void {
  const payload = body ?? JSON.stringify({ error: 'rate_limited' })
  response.writeHead(429, {
    'Content-Type': body === undefined ? 'application/json' : 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Retry-After': String(Math.max(1, retryAfter)),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

/**
 * Guard a request. Returns `true` when it has already been answered.
 *
 * Shaped this way so a call site reads as one line and cannot forget to return:
 *
 *     if (await guard(request, response, 'checkout', token)) return
 */
export async function guard(
  request: IncomingMessage,
  response: ServerResponse,
  name: LimitName,
  key: string,
  options: { html?: string } = {},
): Promise<boolean> {
  const decision = await check(name, key || clientIp(request))
  if (decision.allowed) return false
  tooMany(response, decision.retryAfter, options.html)
  return true
}

/**
 * Drop windows nobody can be inside any more.
 *
 * On a timer rather than on the request path: a sweep inside the hot path is the
 * buyer paying for our housekeeping, and the table is small enough that an hourly
 * pass keeps it that way.
 */
export function startRateLimitSweeper(
  service: SupabaseConfig,
  intervalMs = 15 * 60_000,
): () => void {
  const timer = setInterval(() => {
    void rpc(service, 'rate_limit_sweep', {}).catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
  }
}
