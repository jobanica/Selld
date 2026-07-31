import { IntegrationError } from '@/core/integration/errors'

/**
 * The HTTP plumbing Shopee and Lazada share.
 *
 * Extracted for the same reason `couriers/http.ts` was: the *classification* is
 * the part that matters and it must not drift between marketplaces. Whether a
 * failed stock push is transient decides whether the listing goes back on the
 * queue with a backoff or in front of the seller as a conflict, and two providers
 * disagreeing about what a 429 means is two different operational behaviours for
 * one word.
 *
 * ## Both of these answer 200 with an error inside
 *
 * This is the trap phase 14 learned from Facebook, and it is worse here because
 * *both* marketplaces do it and they do it differently:
 *
 *   Shopee  `{"error":"error_auth","message":"…","response":{}}` — `error` is an
 *           empty string on success, so `if (body.error)` is the test, and a
 *           truthiness check on the *presence* of the key is wrong.
 *   Lazada  `{"code":"0","type":"…","message":"…"}` — `code` is the string "0"
 *           on success. Not the number 0, and not absent.
 *
 * Checking `response.ok` alone reads a refused stock update as a successful one,
 * and the seller finds out when Shopee sells a unit they do not have. So the
 * classification below is the only place that decides, and it is given the parsed
 * body rather than just the status.
 */

/**
 * HMAC-SHA256, hex.
 *
 * Web Crypto rather than `node:crypto`, because `src/core` is the extraction
 * boundary — it becomes `@yourorg/ph-commerce-core` and must run wherever that
 * package is used, which is not necessarily Node. The cost is that signing is
 * async, which it would be anyway inside these providers.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export interface MarketplaceHttpOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Codes both platforms use for "your token is no longer good". */
const AUTH_CODES = new Set([
  'error_auth',
  'error_permission',
  'InvalidAccessToken',
  'IllegalAccessToken',
  'AccessTokenExpired',
  'ApiCallLimit',
])

/**
 * Map a marketplace response onto the retryable/terminal distinction.
 *
 * `auth` is deliberately *not* retryable. A token that has expired will not
 * un-expire on the next attempt, and hammering an expired token is how a partner
 * app gets rate-limited across every shop it serves, not just this one. The
 * worker refreshes and re-queues instead.
 */
export function classifyMarketplaceError(
  provider: string,
  endpoint: string,
  status: number,
  code: string,
  message: string,
): IntegrationError {
  const context = { provider, endpoint, statusCode: status }

  if (AUTH_CODES.has(code) || status === 401 || status === 403) {
    return new IntegrationError('auth', `${provider}: ${code || message}`, context)
  }
  // Shopee says `error_param` and Lazada says `E001` for a listing that no longer
  // exists. Retrying it forever is how a deleted listing keeps a queue busy.
  if (status === 404 || code === 'error_not_found' || code === 'ItemNotFound') {
    return new IntegrationError('permanent', `${provider}: ${code || message}`, context)
  }
  if (status === 429 || status >= 500 || code === 'error_server' || code === 'ApiCallLimit') {
    return new IntegrationError('transient', `${provider} returned ${status} ${code}`, context)
  }
  if (code !== '') {
    return new IntegrationError(
      'permanent',
      `${provider} rejected the request: ${code} ${message}`.trim(),
      context,
    )
  }
  return new IntegrationError('transient', `${provider} returned ${status}`, context)
}

export interface MarketplaceResponse {
  /** Empty string when the call succeeded. */
  code: string
  message: string
  body: Record<string, unknown>
}

/**
 * One call, with the 200-carrying-an-error rule applied.
 *
 * Returns the *envelope*, not the payload, so each provider decides what its own
 * success shape is rather than this file guessing.
 */
export async function marketplaceFetch(
  options: Required<Omit<MarketplaceHttpOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch },
  provider: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
  readEnvelope: (body: Record<string, unknown>) => { code: string; message: string },
): Promise<MarketplaceResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await options.fetchImpl(`${options.baseUrl}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })

    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      // A marketplace behind a load balancer answers HTML during an incident.
      // That is transient, and it is not a parse bug on our side.
      throw new IntegrationError(
        'transient',
        `${provider} returned unparseable body: ${text.slice(0, 200)}`,
        { provider, endpoint: path, statusCode: response.status },
      )
    }

    const { code, message } = readEnvelope(body)
    if (!response.ok || code !== '') {
      throw classifyMarketplaceError(provider, path, response.status, code, message)
    }
    return { code, message, body }
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    // A timeout on a *stock push* is the benign direction: the push is
    // idempotent — it sets an absolute number rather than applying a delta — so
    // a retry that lands twice is the same outcome as landing once. That is why
    // the push carries a quantity and never a difference.
    throw new IntegrationError('transient', `${provider} call failed: ${String(error)}`, {
      provider,
      endpoint: path,
    })
  } finally {
    clearTimeout(timer)
  }
}
