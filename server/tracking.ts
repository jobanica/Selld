import type { IncomingMessage, ServerResponse } from 'node:http'

import { FlashProvider } from '@/core/couriers/flash-provider'
import { JntProvider } from '@/core/couriers/jnt-provider'
import type { CourierProvider, TrackingEvent } from '@/core/couriers/types'
import { smsRegistry } from '@/core/sms'

import { registerSmsProviders } from './order-notifications'
import { readServiceConfig } from './payment-webhook'
import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Tracking in, notifications out.
 *
 * The done-when for this phase is the absence of a question: "nasaan na po order
 * ko" has to stop being asked, which means the buyer learns before they wonder. So
 * the pipeline here is short and has exactly one job — turn a courier's scan into a
 * database row, and let the database decide whether that row is worth a text.
 *
 * ## Why the decision lives in SQL and the sending lives here
 *
 * `record_shipment_event` returns `notifyEvent`, and this file sends whatever it is
 * told. The alternative — deciding here which statuses deserve an SMS — puts the
 * rule in two places the moment the polling fallback is written, and the two
 * disagree the first time someone edits one.
 *
 * ## Every path through here is idempotent, twice over
 *
 * `shipment_events` collapses a duplicate *scan* (a webhook and the poller seeing
 * the same thing). `record_tracking_sms` collapses a duplicate *notification* (two
 * different scans that both mean "out for delivery"). Both are constraints, not
 * checks — a seller charged twice for one text notices, and a buyer texted four
 * times stops reading.
 */

export const COURIER_WEBHOOK_PREFIX = '/api/webhooks/courier/'

const MAX_BODY_BYTES = 64 * 1024

/**
 * A provider instance for parsing only.
 *
 * `parseWebhook` is pure and needs no credentials, which is the whole reason the
 * interface separates it from `track()`. So an inbound webhook never causes a
 * credential to be read out of the database.
 */
function parserFor(courier: string): CourierProvider | null {
  switch (courier) {
    case 'jnt':
      return new JntProvider({ baseUrl: '', customerCode: '', apiKey: '' })
    case 'flash':
      return new FlashProvider({ baseUrl: '', merchantId: '', apiKey: '' })
    default:
      return null
  }
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('too large')
    chunks.push(buffer)
  }
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

interface EventOutcome {
  outcome: string
  applied?: boolean
  tenantId?: string
  orderId?: string
  orderNumber?: string
  notifyEvent?: string | null
}

/**
 * Apply one scan and send whatever it earns.
 *
 * Exported so the poller and the webhook share exactly one path — a fallback that
 * behaved even slightly differently from the push path would produce bugs that only
 * appear for the couriers that do not push, which are the ones nobody tests.
 */
export async function applyTrackingEvent(
  service: SupabaseConfig,
  courier: string,
  event: TrackingEvent,
  source: 'webhook' | 'poll',
  rootUrl: string,
): Promise<EventOutcome> {
  const outcome = await rpc<EventOutcome>(service, 'record_shipment_event', {
    p_courier: courier,
    p_waybill: event.waybill,
    p_status: event.status,
    p_raw_code: event.rawCode,
    p_occurred_at: event.occurredAt.toISOString(),
    p_description: event.description === '' ? null : event.description,
    p_location: event.location ?? null,
    p_source: source,
    p_raw: event.raw ?? null,
  })

  const notify = outcome.notifyEvent
  if (outcome.applied !== true || notify == null || outcome.orderId === undefined) {
    return outcome
  }

  await notifyBuyer(service, outcome.orderId, notify, rootUrl).catch(() => {
    // A failed notification must never undo a recorded scan. The parcel moved
    // whether or not the text went out, and the tracking page still answers.
  })

  return outcome
}

/**
 * Render, send, record, charge.
 *
 * `sms_render_for_order` returns null when the template is switched off, so a
 * seller who does not want a particular text simply gets no send — one check rather
 * than a flag consulted in three places.
 */
export async function notifyBuyer(
  service: SupabaseConfig,
  orderId: string,
  event: string,
  rootUrl: string,
): Promise<void> {
  const message = await rpc<{
    to: string
    body: string
    tenantId: string
    orderNumber: string
    balance: number
  } | null>(service, 'sms_render_for_order', {
    p_order_id: orderId,
    p_event: event,
    p_root_url: rootUrl,
  })

  if (message === null) return

  // No credits, no send. Sending anyway and reconciling later is how a seller
  // discovers a bill they never agreed to.
  if (message.balance <= 0) {
    await rpc(service, 'record_tracking_sms', {
      p_tenant_id: message.tenantId,
      p_order_id: orderId,
      p_event: event,
      p_to: message.to,
      p_body: message.body,
      p_provider: 'none',
      p_provider_ref: null,
      p_status: 'rejected',
      p_cost: 0,
      p_segments: 1,
    }).catch(() => undefined)
    return
  }

  // Registered at startup, never at import time — the project convention that lets
  // a test install a fake. Calling it here is idempotent.
  registerSmsProviders()
  const provider = smsRegistry.find('log') ?? smsRegistry.all()[0]
  if (provider === undefined) return

  const result = await provider.send({
    to: message.to,
    body: message.body,
    purpose: 'tracking',
    idempotencyKey: `${orderId}:${event}`,
  })

  await rpc(service, 'record_tracking_sms', {
    p_tenant_id: message.tenantId,
    p_order_id: orderId,
    p_event: event,
    p_to: message.to,
    p_body: message.body,
    p_provider: result.provider,
    p_provider_ref: result.providerRef ?? null,
    p_status: result.status,
    p_cost: result.cost,
    p_segments: result.segments,
  })
}

/**
 * The inbound courier webhook.
 *
 * Unlike the payment webhook there is no signature to verify — neither J&T nor
 * Flash signs its tracking pushes — so the URL carries an unguessable per-courier
 * secret and the payload is trusted only as far as a *waybill we already booked*.
 * An event for a waybill we have never seen is recorded as unmatched and changes
 * nothing, which is what keeps a forged push from inventing a delivery.
 */
export async function serveCourierWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  rootUrl: string,
): Promise<boolean> {
  if (!pathname.startsWith(COURIER_WEBHOOK_PREFIX)) return false

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const rest = pathname.slice(COURIER_WEBHOOK_PREFIX.length).split('/')
  const courier = rest[0] ?? ''
  const secret = rest[1] ?? ''
  const expected = process.env['COURIER_WEBHOOK_SECRET'] ?? ''

  const service = readServiceConfig()
  if (service === null || expected === '') {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  // Length-independent comparison is overkill for a path segment an attacker can
  // already probe freely, but the cost is nothing and the habit is worth keeping.
  if (secret.length !== expected.length || secret !== expected) {
    send(response, 404, { error: 'unknown_endpoint' })
    return true
  }

  const parser = parserFor(courier)
  if (parser === null) {
    send(response, 404, { error: 'unknown_courier' })
    return true
  }

  let payload: unknown
  try {
    payload = JSON.parse(await readRawBody(request))
  } catch {
    // Acknowledged, not retried: a body that is not JSON will not become JSON.
    send(response, 200, { outcome: 'unparseable' })
    return true
  }

  const events = parser.parseWebhook(payload)
  if (events.length === 0) {
    send(response, 200, { outcome: 'ignored' })
    return true
  }

  const outcomes: EventOutcome[] = []
  try {
    for (const event of events) {
      outcomes.push(await applyTrackingEvent(service, courier, event, 'webhook', rootUrl))
    }
  } catch {
    // The database refused or was unreachable — worth a retry, so this is the one
    // 5xx. Redelivery is safe: the unique constraint makes it a no-op.
    send(response, 503, { error: 'record_failed' })
    return true
  }

  send(response, 200, { outcome: 'ok', events: outcomes })
  return true
}

/**
 * The polling fallback.
 *
 * Exists because a courier that never pushes is not a hypothetical: J&T's webhook
 * setup is per-merchant and frequently not done, and a seller whose tracking is
 * silent has exactly the problem this phase was written to remove.
 *
 * Only parcels still moving, only those we have not heard about in hours, and
 * bounded per run — see `shipments_to_poll`.
 */
export async function pollShipments(
  service: SupabaseConfig,
  rootUrl: string,
  options: { limit?: number; providerFor?: (courier: string) => CourierProvider | null } = {},
): Promise<{ polled: number; events: number }> {
  const due = await rpc<{ tenantId: string; courier: string; waybill: string }[]>(
    service,
    'shipments_to_poll',
    { p_limit: options.limit ?? 100 },
  )

  let events = 0
  for (const parcel of due) {
    const provider = (options.providerFor ?? parserFor)(parcel.courier)
    if (provider === null) continue
    try {
      for (const event of await provider.track(parcel.waybill)) {
        await applyTrackingEvent(service, parcel.courier, event, 'poll', rootUrl)
        events += 1
      }
    } catch {
      // One unreachable courier must not stop the rest of the sweep.
    }
  }

  return { polled: due.length, events }
}
