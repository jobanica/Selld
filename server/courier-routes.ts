import type { IncomingMessage, ServerResponse } from 'node:http'

import { IntegrationError } from '@/core/integration/errors'
import { idempotencyKey } from '@/core/integration/idempotency'
import { withRetry } from '@/core/integration/retry'
import { FlashProvider } from '@/core/couriers/flash-provider'
import { JntProvider } from '@/core/couriers/jnt-provider'
import type { BookInput, CourierProvider } from '@/core/couriers/types'
import type { Centavos } from '@/lib/money'

import { mergeLabels, type LabelRef } from './label-pdf'
import { readServiceConfig } from './payment-webhook'
import { rpc, RpcError, type SupabaseConfig } from './supabase-rpc'

/**
 * Bulk courier booking.
 *
 * Runs on the Node server rather than in the dashboard for one reason: booking
 * needs the tenant's courier credentials, and a credential a browser can hold is a
 * credential a seller's browser extension can read. The dashboard sends its
 * Supabase JWT; this verifies it, checks tenant membership *in the database*, and
 * only then decrypts anything.
 *
 * ## Authorisation, in order
 *
 *   1. Take the caller's JWT from the Authorization header.
 *   2. Ask PostgREST, **as that caller**, for the booking batch. `courier_booking_batch`
 *      is SECURITY DEFINER and checks `has_tenant_role(tenant, 'packer')` — so the
 *      membership decision is made by the database, against the caller's own token,
 *      not by anything this file believes about them.
 *   3. Only if that returns do we use the service role to decrypt credentials.
 *
 * The order matters. Verifying with the service role first and checking membership
 * after would make step 2 advisory.
 *
 * ## Why the batch is bounded and parallel
 *
 * Forty bookings are forty round trips to someone else's API. Sequential, that is
 * the whole 30-second budget; unbounded, it is forty simultaneous connections and a
 * courier that starts 429ing. Eight at a time is the same shape as the label
 * fetcher.
 */

const BOOK_CONCURRENCY = 8
const MAX_BATCH = 100

export const COURIER_BOOK_PATH = '/api/couriers/book'
export const COURIER_LABELS_PATH = '/api/couriers/labels'
export const COURIER_CONNECT_PATH = '/api/couriers/connect'

interface BatchOrder {
  id: string
  orderNumber: string
  contactName: string
  contactPhone: string
  address: Record<string, string | null>
  notes: string | null
  codAmount: number
  declaredValue: number
  weightGrams: number
}

interface BookingBatch {
  accountId: string
  courier: string
  origin: Record<string, string | null>
  senderName: string
  senderPhone: string
  accountRef: string | null
  orders: BatchOrder[]
}

/**
 * A PostgREST client bound to the *caller's* token.
 *
 * Deliberately not the anon key and not the service role: every RPC made with this
 * runs as the signed-in seller, so RLS and the role checks inside the SECURITY
 * DEFINER functions apply exactly as they would from the dashboard.
 */
function asCaller(config: SupabaseConfig, jwt: string): SupabaseConfig & { jwt: string } {
  return { ...config, jwt }
}

async function callerRpc<T>(
  config: SupabaseConfig & { jwt: string },
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  if (!response.ok) throw new RpcError(name, response.status, text)
  return (text === '' ? null : JSON.parse(text)) as T
}

function buildProvider(
  courier: string,
  credentials: Record<string, string>,
): CourierProvider {
  switch (courier) {
    case 'jnt':
      return new JntProvider({
        baseUrl: credentials['baseUrl'] ?? 'https://api.jtexpress.ph',
        customerCode: credentials['customerCode'] ?? '',
        apiKey: credentials['apiKey'] ?? '',
      })
    case 'flash':
      return new FlashProvider({
        baseUrl: credentials['baseUrl'] ?? 'https://open-api.flashexpress.com',
        merchantId: credentials['merchantId'] ?? '',
        apiKey: credentials['apiKey'] ?? '',
      })
    default:
      throw new Error(`No provider for courier ${courier}`)
  }
}

function toCourierAddress(address: Record<string, string | null>) {
  return {
    regionCode: address['regionCode'] ?? '',
    provinceCode: address['provinceCode'] ?? null,
    cityCode: address['cityCode'] ?? '',
    barangayCode: address['barangayCode'] ?? '',
    street: address['street'] ?? '',
    ...(address['postalCode'] == null ? {} : { postalCode: address['postalCode'] }),
    ...(address['landmark'] == null ? {} : { landmark: address['landmark'] }),
  }
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await worker(items[index] as T)
      }
    }),
  )
  return results
}

export interface BookOutcome {
  status: number
  body: Record<string, unknown>
}

export async function bookBatch(input: {
  jwt: string
  tenantId: string
  orderIds: string[]
  courier: string
  service: string
  anon: SupabaseConfig | null
  service_: SupabaseConfig | null
  fetchImpl?: typeof fetch
}): Promise<BookOutcome> {
  if (input.anon === null || input.service_ === null) {
    return { status: 503, body: { error: 'not_configured' } }
  }
  if (input.orderIds.length === 0) {
    return { status: 400, body: { error: 'no_orders' } }
  }
  if (input.orderIds.length > MAX_BATCH) {
    return { status: 400, body: { error: 'batch_too_large', max: MAX_BATCH } }
  }

  // ---- 1 & 2. The database decides whether this caller may book -----------
  let batch: BookingBatch
  try {
    batch = await callerRpc<BookingBatch>(
      asCaller(input.anon, input.jwt),
      'courier_booking_batch',
      { p_tenant_id: input.tenantId, p_order_ids: input.orderIds, p_courier: input.courier },
    )
  } catch (error) {
    if (error instanceof RpcError) {
      const message = error.message.toLowerCase()
      if (message.includes('not allowed')) return { status: 403, body: { error: 'not_allowed' } }
      if (message.includes('courier_not_connected')) {
        return { status: 409, body: { error: 'courier_not_connected' } }
      }
      return { status: 400, body: { error: 'batch_failed' } }
    }
    throw error
  }

  if (batch === null || batch.orders.length === 0) {
    // Nothing left to book — every selected order already has a shipment. Not an
    // error: re-running a batch after a partial failure is the normal way to
    // recover, and it should say "nothing to do" rather than fail.
    return { status: 200, body: { booked: 0, failed: 0, alreadyBooked: input.orderIds.length } }
  }

  // ---- 3. Only now, the credentials ---------------------------------------
  const key = process.env['COURIER_CREDENTIALS_KEY'] ?? ''
  if (key === '') return { status: 503, body: { error: 'no_encryption_key' } }

  const credentials = await rpc<Record<string, string> | null>(
    input.service_,
    'courier_credentials',
    { p_account_id: batch.accountId, p_key: key },
  )
  if (credentials === null) return { status: 409, body: { error: 'courier_not_connected' } }

  const provider = buildProvider(batch.courier, credentials)
  const origin = toCourierAddress(batch.origin)

  const results = await mapWithLimit(batch.orders, BOOK_CONCURRENCY, async (order) => {
    const bookInput: BookInput = {
      reference: order.orderNumber,
      origin,
      destination: toCourierAddress(order.address),
      senderName: batch.senderName,
      senderPhone: batch.senderPhone,
      recipientName: order.contactName,
      recipientPhone: order.contactPhone,
      parcel: { weightGrams: order.weightGrams },
      service: input.service,
      ...(order.codAmount > 0 ? { codAmount: order.codAmount as Centavos } : {}),
      declaredValue: order.declaredValue as Centavos,
      ...(order.notes === null ? {} : { remarks: order.notes }),
      // Derived from the order, so a retry after a timeout is recognised by the
      // courier as the same request rather than booking a second parcel.
      idempotencyKey: idempotencyKey({
        tenantId: input.tenantId,
        operation: 'shipment.book',
        entityId: order.id,
      }),
    }

    try {
      const booking = await withRetry(() => provider.book(bookInput), { attempts: 3 })
      await rpc(input.service_ as SupabaseConfig, 'record_shipment', {
        p_tenant_id: input.tenantId,
        p_order_id: order.id,
        p_courier: batch.courier,
        p_waybill: booking.waybill,
        p_service: booking.service,
        p_label_url: booking.labelUrl === '' ? null : booking.labelUrl,
        p_cost: booking.amount ?? null,
        p_cod: order.codAmount,
        p_weight: order.weightGrams,
        p_raw: null,
      })
      return { ok: true as const, orderId: order.id, waybill: booking.waybill }
    } catch (error) {
      const kind =
        error instanceof IntegrationError
          ? error.kind === 'duplicate'
            ? 'transient'
            : error.kind
          : 'transient'
      await rpc(input.service_ as SupabaseConfig, 'record_booking_failure', {
        p_tenant_id: input.tenantId,
        p_order_id: order.id,
        p_courier: batch.courier,
        // `duplicate` is folded into transient: the courier says it already has
        // this request, so a retry will return the waybill rather than book again.
        p_kind: kind === 'auth' ? 'auth' : kind === 'permanent' ? 'permanent' : 'transient',
        p_message: error instanceof Error ? error.message : String(error),
        p_code: error instanceof IntegrationError ? error.kind : null,
      }).catch(() => {
        // Recording the failure must not itself fail the batch.
      })
      return {
        ok: false as const,
        orderId: order.id,
        orderNumber: order.orderNumber,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      }
    }
  })

  const booked = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  return {
    status: 200,
    body: {
      booked: booked.length,
      failed: failed.length,
      alreadyBooked: input.orderIds.length - batch.orders.length,
      failures: failed,
    },
  }
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) throw new Error('too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** HTTP entry point. Returns true when it handled the request. */
export async function serveCourierRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  anon: SupabaseConfig | null,
): Promise<boolean> {
  if (
    pathname !== COURIER_BOOK_PATH &&
    pathname !== COURIER_LABELS_PATH &&
    pathname !== COURIER_CONNECT_PATH
  ) {
    return false
  }

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const jwt = bearer(request)
  if (jwt === '') {
    send(response, 401, { error: 'unauthenticated' })
    return true
  }

  let body: Record<string, unknown>
  try {
    body = await readJson(request)
  } catch {
    send(response, 400, { error: 'bad_request' })
    return true
  }

  const tenantId = String(body['tenantId'] ?? '')
  const orderIds = Array.isArray(body['orderIds']) ? (body['orderIds'] as string[]) : []
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    send(response, 400, { error: 'bad_request' })
    return true
  }

  /**
   * Storing credentials.
   *
   * Here rather than in the dashboard because the encryption key is the server's.
   * Authorisation is still the database's: `courier_accounts` is admin-only under
   * RLS, so the caller's own token has to be able to see the row before the service
   * role is used to encrypt into it.
   */
  if (pathname === COURIER_CONNECT_PATH) {
    const service = readServiceConfig()
    if (anon === null || service === null) {
      send(response, 503, { error: 'not_configured' })
      return true
    }
    const key = process.env['COURIER_CREDENTIALS_KEY'] ?? ''
    if (key === '') {
      send(response, 503, { error: 'no_encryption_key' })
      return true
    }

    const courier = String(body['courier'] ?? '')
    const credentials = body['credentials']
    if (courier === '' || credentials === null || typeof credentials !== 'object') {
      send(response, 400, { error: 'bad_request' })
      return true
    }

    // The caller must be able to read the account under their own token. An admin
    // can; a packer cannot; another tenant's admin gets nothing.
    try {
      const rows = await fetch(
        `${anon.url}/rest/v1/courier_accounts?tenant_id=eq.${tenantId}` +
          `&courier=eq.${encodeURIComponent(courier)}&select=id`,
        { headers: { apikey: anon.anonKey, Authorization: `Bearer ${jwt}` } },
      )
      const found = (await rows.json()) as { id: string }[]
      if (!rows.ok || found.length === 0) {
        send(response, 403, { error: 'not_allowed' })
        return true
      }
    } catch {
      send(response, 503, { error: 'lookup_failed' })
      return true
    }

    await rpc(service, 'set_courier_credentials', {
      p_tenant_id: tenantId,
      p_courier: courier,
      p_credentials: credentials,
      p_key: key,
    })
    send(response, 200, { ok: true })
    return true
  }

  if (pathname === COURIER_BOOK_PATH) {
    const outcome = await bookBatch({
      jwt,
      tenantId,
      orderIds,
      courier: String(body['courier'] ?? 'jnt'),
      service: String(body['service'] ?? 'standard'),
      anon,
      service_: readServiceConfig(),
    })
    send(response, outcome.status, outcome.body)
    return true
  }

  // ---- The merged label PDF -----------------------------------------------
  if (anon === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  let labels: LabelRef[]
  try {
    // Read as the caller: `shipment_labels` carries `is_tenant_member`, so a JWT
    // for another tenant gets an empty list rather than someone else's waybills.
    labels = await callerRpc<LabelRef[]>(asCaller(anon, jwt), 'shipment_labels', {
      p_tenant_id: tenantId,
      p_order_ids: orderIds,
    })
  } catch {
    send(response, 403, { error: 'not_allowed' })
    return true
  }

  if (labels.length === 0) {
    send(response, 404, { error: 'no_labels' })
    return true
  }

  const merged = await mergeLabels(labels)
  response.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': merged.bytes.length,
    'Content-Disposition': `attachment; filename="labels-${labels.length}.pdf"`,
    'Cache-Control': 'no-store',
    // So the dashboard can tell the seller which labels are placeholders without
    // parsing the PDF.
    'X-Labels-Missing': String(merged.missing.length),
  })
  response.end(Buffer.from(merged.bytes))
  return true
}
