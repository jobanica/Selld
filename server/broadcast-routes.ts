import type { IncomingMessage, ServerResponse } from 'node:http'

import { messengerRegistry } from '@/core/messaging'
import { smsRegistry } from '@/core/sms'

import { registerSmsProviders } from './order-notifications'
import { readServiceConfig } from './payment-webhook'
import { registerSocialProviders } from './social-routes'
import { readSupabaseConfig, rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Sending a broadcast, and the short links it carries.
 *
 * ## Why the loop is here and not in the database
 *
 * The decisions are all in SQL — who is reachable, what it costs, whether the
 * credit could be taken. What is left is the part Postgres cannot do: call
 * somebody else's HTTP API. So this file is a loop around
 * `broadcast_claim_next` / `broadcast_record_send`, and every rule it appears to
 * enforce is actually enforced on the other side of those two calls.
 *
 * ## Why one recipient at a time
 *
 * `broadcast_claim_next` takes the credit *before* returning the message, and
 * `for update skip locked` means two workers can run this loop against the same
 * broadcast without sending anybody two copies. A seller who closes the tab
 * halfway through has spent exactly what was sent; pressing send again picks up
 * where it stopped, because the recipients that already went are no longer
 * `pending`.
 */

export const SHORT_LINK_PREFIX = '/s/'
const BROADCAST_SEND_PATH = /^\/api\/broadcasts\/([0-9a-f-]{36})\/send$/i

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

interface Claim {
  recipientId: string
  tenantId: string
  channel: 'sms' | 'messenger'
  address: string | null
  pageId: string | null
  body: string
  segments: number
  broadcastId: string
}

/**
 * Drain one broadcast's pending recipients.
 *
 * Exported so the proof drives exactly this function over HTTP rather than a
 * copy of it. `limit` exists because a browser request that sends 800 messages
 * synchronously is a browser request that times out; the dashboard calls this
 * repeatedly until `remaining` is zero, which also gives it a progress bar for
 * free.
 */
export async function drainBroadcast(
  service: SupabaseConfig,
  broadcastId: string,
  limit = 100,
): Promise<{ sent: number; failed: number; skipped: number; remaining: boolean }> {
  registerSmsProviders()
  registerSocialProviders(service)

  const sms = smsRegistry.find('log') ?? smsRegistry.all()[0]
  const messenger = messengerRegistry.find('facebook') ?? messengerRegistry.all()[0]

  let sent = 0
  let failed = 0
  let skipped = 0

  for (let index = 0; index < limit; index += 1) {
    const claim = await rpc<Claim | null>(service, 'broadcast_claim_next', {
      p_broadcast_id: broadcastId,
    })

    // Null means there is nobody pending left, and the database has already
    // closed the broadcast out.
    if (claim === null) return { sent, failed, skipped, remaining: false }

    // A recipient the database refused to charge. It has already been marked
    // skipped; there is nothing to send and nothing to record.
    if (claim.recipientId !== undefined && claim.body === undefined) {
      skipped += 1
      continue
    }

    let ok = false
    let unreachable = false
    let providerRef: string | null = null
    let error: string | null

    try {
      error = null
      if (claim.channel === 'sms' && sms !== undefined && claim.address !== null) {
        const result = await sms.send({
          to: claim.address,
          body: claim.body,
          purpose: 'broadcast',
          // Stable per recipient: a retry of this loop cannot send twice, and
          // the provider can recognise the duplicate even if we do.
          idempotencyKey: `broadcast:${claim.recipientId}`,
        })
        // `SmsResult` has no error field: a provider that could not send throws,
        // and anything that comes back is a status the provider stands behind.
        ok = result.status === 'sent' || result.status === 'queued'
        providerRef = result.providerRef
        if (!ok) error = result.status
      } else if (claim.channel === 'messenger' && messenger !== undefined) {
        const result = await messenger.send({
          psid: claim.address ?? '',
          pageId: claim.pageId,
          tenantId: claim.tenantId,
          text: claim.body,
          purpose: 'auto_reply',
          idempotencyKey: `broadcast:${claim.recipientId}`,
        })
        ok = result.status === 'sent'
        // `skipped` is the provider saying "this channel cannot carry it" — no
        // Page connected, no token, nothing to retry. A failure is a send that
        // was attempted and refused; this was never attempted.
        unreachable = result.status === 'skipped'
        providerRef = result.providerRef ?? null
        error = result.error ?? null
      } else {
        error = 'no_provider'
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }

    await rpc(service, 'broadcast_record_send', {
      p_recipient_id: claim.recipientId,
      p_status: ok ? 'sent' : unreachable ? 'skipped' : 'failed',
      p_provider_ref: providerRef,
      p_error: error,
      p_body: claim.body,
    }).catch(() => {})

    if (ok) sent += 1
    else if (unreachable) skipped += 1
    else failed += 1
  }

  return { sent, failed, skipped, remaining: true }
}

/**
 * `POST /api/broadcasts/{id}/send`
 *
 * Authorisation is the database's, in two steps: the caller's own token has to
 * be able to *see* the broadcast — `broadcasts` carries `is_tenant_member` under
 * RLS — and `broadcast_start` then checks for `staff` before it freezes an
 * audience or spends a credit. This file checks nothing on its own, which is the
 * point: a second copy of the rule is a second thing to get wrong.
 */
export async function serveBroadcastRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = BROADCAST_SEND_PATH.exec(url.pathname)
  if (match === null) return false

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const service = readServiceConfig()
  const anon = readSupabaseConfig()
  if (service === null || anon === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  const jwt = bearer(request)
  const broadcastId = match[1] as string
  if (jwt === '') {
    send(response, 401, { error: 'unauthenticated' })
    return true
  }

  // Read it as the caller. A JWT for another store sees an empty list rather
  // than somebody else's send.
  const visible = await fetch(
    `${anon.url}/rest/v1/broadcasts?id=eq.${broadcastId}&select=id,status`,
    { headers: { apikey: anon.anonKey, Authorization: `Bearer ${jwt}` } },
  )
    .then(async (r) => (r.ok ? ((await r.json()) as { id: string }[]) : []))
    .catch(() => [])

  if (visible.length === 0) {
    send(response, 403, { error: 'not_allowed' })
    return true
  }

  // Freezing the audience is idempotent: a broadcast already sending answers
  // `already_started` and the loop simply carries on with what is pending.
  const started = await fetch(`${anon.url}/rest/v1/rpc/broadcast_start`, {
    method: 'POST',
    headers: {
      apikey: anon.anonKey,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_broadcast_id: broadcastId }),
  })

  if (!started.ok) {
    send(response, 403, { error: 'not_allowed' })
    return true
  }

  try {
    const outcome = await drainBroadcast(service, broadcastId, 1000)
    send(response, 200, outcome)
  } catch (cause) {
    send(response, 503, {
      error: 'send_failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    })
  }
  return true
}

/**
 * `/s/{slug}` — follow a short link.
 *
 * A 302 rather than a 301: a permanent redirect is cached by the browser and by
 * every proxy between here and the buyer, and the second tap would never reach
 * us. The whole reason this endpoint exists is to be reached.
 */
export async function serveShortLink(
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith(SHORT_LINK_PREFIX)) return false

  const slug = url.pathname.slice(SHORT_LINK_PREFIX.length).split('/')[0] ?? ''
  if (!/^[a-z0-9]{5,12}$/.test(slug)) return false

  const anon = readSupabaseConfig()
  if (anon === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  const followed = await rpc<{ target: string | null; expired: boolean } | null>(
    anon,
    'short_link_follow',
    { p_slug: slug, p_recipient: null },
  ).catch(() => null)

  if (followed === null || followed.target === null) {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Link not found')
    return true
  }

  response
    .writeHead(302, {
      Location: followed.target,
      'Cache-Control': 'no-store',
      // A short link is a marketing link. Keeping it out of the index stops the
      // redirect itself from ranking for the store's own name.
      'X-Robots-Tag': 'noindex',
    })
    .end()
  return true
}
