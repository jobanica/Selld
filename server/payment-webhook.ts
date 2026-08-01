import type { IncomingMessage, ServerResponse } from 'node:http'

import { XenditProvider } from '@/core/payments/xendit-provider'

import { guard } from './rate-limit'

import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * The inbound payment webhook.
 *
 * This is the endpoint the phase-8 done-when is about: a GCash payment moves the
 * order to `paid` here, with no polling, and replaying the same delivery changes
 * nothing.
 *
 * ## Why this runs with the service role
 *
 * Every other server route uses the anon key, deliberately, so the renderer has
 * exactly a buyer's privileges. This one cannot: it marks orders paid, and no
 * client role may do that. The trade is that the authorisation decision moves
 * *into this file* — it is made by verifying the delivery, not by the database. So
 * the order of operations below is not stylistic:
 *
 *   1. resolve the account from the opaque URL slug
 *   2. verify `x-callback-token` against that account, in constant time
 *   3. only then hand the payload to `record_payment_event`
 *
 * Anything that reverses 2 and 3 turns this into a "mark any order paid" endpoint
 * reachable by anyone who can guess an invoice id.
 *
 * ## Why the URL carries a slug and not a tenant id
 *
 * Xendit's callback token is a static per-account secret, so we must know *whose*
 * account a delivery belongs to before we can check it. The tenant id would work
 * and would be printed on a settings screen, in provider dashboards, and in every
 * support screenshot. An opaque 32-byte slug identifies the account and names
 * nothing.
 *
 * ## Why a bad payload still answers 200
 *
 * Xendit retries any non-2xx. A delivery we cannot match to a payment is not going
 * to start matching on the fourth attempt, so retrying it forever is pure noise —
 * it is recorded in `webhook_events` as `ignored` and acknowledged. Only failures
 * that a retry could plausibly fix (our database being down) answer 5xx.
 */

/** A payment callback is small. Anything larger is not Xendit. */
const MAX_BODY_BYTES = 64 * 1024

export const WEBHOOK_PREFIX = '/api/webhooks/xendit/'

interface PaymentAccountRow {
  tenant_id: string
  provider: string
  callback_token: string | null
  is_enabled: boolean
}

/**
 * Service-role PostgREST config.
 *
 * Kept separate from the renderer's anon config and read at call time, so a
 * deployment that forgets the key fails this route only rather than the storefront.
 */
export function readServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseConfig | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || key === undefined) return null
  if (url.trim() === '' || key.trim() === '') return null
  return { url: url.trim().replace(/\/+$/, ''), anonKey: key.trim() }
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Webhook body too large')
    chunks.push(buffer)
  }
  // The raw text, not a parsed object: a provider that signs the body would need
  // the exact bytes, and re-serialising JSON does not reproduce them.
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

export interface WebhookOutcome {
  status: number
  body: Record<string, unknown>
}

/**
 * The handler, split from the HTTP plumbing so it can be driven directly by a test.
 */
export async function handleXenditWebhook(input: {
  slug: string
  rawBody: string
  headers: Record<string, string | undefined>
  service: SupabaseConfig | null
}): Promise<WebhookOutcome> {
  if (input.service === null) {
    // A misconfigured deployment is our fault and a retry may well succeed once it
    // is fixed, so this is one of the few 5xx cases.
    return { status: 503, body: { error: 'payments_not_configured' } }
  }

  if (input.slug === '' || !/^[0-9a-f]{64}$/.test(input.slug)) {
    return { status: 404, body: { error: 'unknown_endpoint' } }
  }

  // ---- 1. Whose account is this? ------------------------------------------
  let account: PaymentAccountRow | undefined
  try {
    const rows = await rpc<PaymentAccountRow[]>(
      input.service,
      'payment_account_for_webhook',
      { p_slug: input.slug },
    )
    account = rows[0]
  } catch {
    return { status: 503, body: { error: 'lookup_failed' } }
  }

  // Same answer as a malformed slug. Distinguishing "no such endpoint" from "that
  // endpoint exists but is off" would let someone enumerate live stores.
  if (account === undefined || !account.is_enabled || account.callback_token === null) {
    return { status: 404, body: { error: 'unknown_endpoint' } }
  }

  // ---- 2. Is it really from Xendit? ---------------------------------------
  const provider = new XenditProvider({
    // Verification needs only the callback token; the secret key is never fetched
    // here, so an inbound request cannot cause it to be read out of the database.
    secretKey: 'unused-for-verification',
    callbackToken: account.callback_token,
  })

  if (!provider.verifyWebhook({ rawBody: input.rawBody, headers: input.headers })) {
    // 401 and nothing else. No hint about whether the slug was right.
    return { status: 401, body: { error: 'bad_signature' } }
  }

  // ---- 3. Only now is the body worth parsing ------------------------------
  let payload: unknown
  try {
    payload = JSON.parse(input.rawBody)
  } catch {
    return { status: 200, body: { outcome: 'unparseable' } }
  }

  const events = provider.parseWebhook(payload)
  if (events.length === 0) {
    // A callback type we do not handle. Acknowledged so it is not retried.
    return { status: 200, body: { outcome: 'ignored' } }
  }

  const results: unknown[] = []
  for (const event of events) {
    try {
      const result = await rpc<Record<string, unknown>>(
        input.service,
        'record_payment_event',
        {
          p_provider: 'xendit',
          p_external_id: event.externalId,
          p_event_type: `invoice.${event.status}`,
          p_provider_ref: event.providerRef,
          p_status: event.status,
          p_amount: event.amount,
          p_payload: event.raw,
          p_fee: event.feeCentavos ?? null,
          p_paid_at: event.paidAt?.toISOString() ?? null,
        },
      )
      results.push(result)
    } catch {
      // The database refused or was unreachable. This *is* worth a retry, so it is
      // the one place a 5xx is the right answer — Xendit will redeliver, and the
      // unique constraint means the redelivery is safe whether or not this one
      // partially applied.
      return { status: 503, body: { error: 'record_failed' } }
    }
  }

  return { status: 200, body: { outcome: 'ok', results } }
}

/** HTTP entry point. Returns true when it handled the request. */
export async function serveXenditWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(WEBHOOK_PREFIX)) return false

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  // Keyed on the opaque account slug, so one seller's provider having a bad day
  // cannot spend another seller's budget. A 429 is the right answer here rather
  // than a 200: Xendit retries a non-2xx, so a refused delivery comes back
  // instead of being lost.
  const slug = pathname.slice(WEBHOOK_PREFIX.length).split('/')[0] ?? ''
  if (await guard(request, response, 'webhook', slug)) return true

  let rawBody: string
  try {
    rawBody = await readRawBody(request)
  } catch {
    send(response, 413, { error: 'body_too_large' })
    return true
  }

  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }

  const outcome = await handleXenditWebhook({
    slug: decodeURIComponent(pathname.slice(WEBHOOK_PREFIX.length)).replace(/\/+$/, ''),
    rawBody,
    headers,
    service: readServiceConfig(),
  })

  send(response, outcome.status, outcome.body)
  return true
}
