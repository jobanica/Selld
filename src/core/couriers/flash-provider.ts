import { centavos, type Centavos } from '@/lib/money'

import { courierFetch, type CourierHttpOptions } from './http'
import type {
  BookInput,
  Booking,
  CourierProvider,
  QuoteInput,
  Rate,
  TrackingEvent,
  TrackingStatus,
} from './types'

/**
 * Flash Express Philippines.
 *
 * The second of the two this phase implements, and deliberately a *different* API
 * shape from J&T: string status names instead of numeric codes, satang-style
 * integer minor units instead of peso decimals, and a flat body instead of nested
 * sender/receiver objects.
 *
 * That difference is the point. Two couriers that happened to look alike would not
 * prove the `CourierProvider` boundary holds — and the boundary is what makes
 * adding LBC later a new file plus one registry line, rather than a change to order
 * logic.
 *
 * Flash takes amounts in **integer centavos already**, so unlike J&T there is no
 * peso conversion here at all. Writing one anyway is the mistake this comment
 * exists to prevent: it would multiply every COD amount by a hundred.
 */

const FLASH_STATUS: Record<string, TrackingStatus> = {
  READY_TO_SHIP: 'booked',
  PICKED_UP: 'picked_up',
  IN_TRANSIT: 'in_transit',
  AT_SORTING_CENTER: 'in_transit',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  RETURN_IN_TRANSIT: 'returning',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
}

export interface FlashConfig extends CourierHttpOptions {
  merchantId: string
  apiKey: string
}

export class FlashProvider implements CourierProvider {
  readonly id = 'flash' as const
  readonly label = 'Flash Express'

  private readonly options: Required<Omit<CourierHttpOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch
  }
  private readonly merchantId: string
  private readonly apiKey: string

  constructor(config: FlashConfig) {
    this.merchantId = config.merchantId
    this.apiKey = config.apiKey
    this.options = {
      baseUrl: config.baseUrl,
      fetchImpl: config.fetchImpl ?? globalThis.fetch,
      timeoutMs: config.timeoutMs ?? 15_000,
    }
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'X-Merchant-Id': this.merchantId,
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    }
  }

  async quote(input: QuoteInput): Promise<Rate[]> {
    const body = await courierFetch<{
      data?: { service: string; name: string; price: number; days?: number }[]
    }>(this.options, 'flash', '/open/v1/rates', {
      method: 'POST',
      headers: this.headers(),
      body: {
        src_city_code: input.origin.cityCode,
        src_barangay_code: input.origin.barangayCode,
        dst_city_code: input.destination.cityCode,
        dst_barangay_code: input.destination.barangayCode,
        weight: input.parcel.weightGrams,
        // Already centavos. No conversion — see the note at the top of the file.
        insured_value: input.declaredValue ?? 0,
        cod_amount: input.codAmount ?? 0,
      },
    })

    return (body.data ?? []).map((rate) => ({
      provider: 'flash' as const,
      service: rate.service,
      serviceLabel: rate.name,
      amount: centavos(rate.price),
      ...(rate.days === undefined ? {} : { etaMinDays: rate.days, etaMaxDays: rate.days }),
    }))
  }

  async book(input: BookInput): Promise<Booking> {
    const body = await courierFetch<{
      data?: { pno?: string; tracking_no?: string; label_url?: string; price?: number }
    }>(this.options, 'flash', '/open/v1/orders', {
      method: 'POST',
      headers: this.headers(input.idempotencyKey),
      body: {
        out_trade_no: input.reference,
        express_category: input.service,
        src_name: input.senderName,
        src_phone: input.senderPhone,
        src_city_code: input.origin.cityCode,
        src_barangay_code: input.origin.barangayCode,
        src_detail_address: input.origin.street,
        dst_name: input.recipientName,
        dst_phone: input.recipientPhone,
        dst_city_code: input.destination.cityCode,
        dst_barangay_code: input.destination.barangayCode,
        dst_detail_address: input.destination.street,
        weight: input.parcel.weightGrams,
        cod_amount: input.codAmount ?? 0,
        insured_value: input.declaredValue ?? 0,
        remark: input.remarks,
      },
    })

    const waybill = body.data?.pno ?? body.data?.tracking_no ?? ''
    if (waybill === '') {
      throw new Error('Flash accepted the booking but returned no waybill')
    }

    return {
      waybill,
      labelUrl: body.data?.label_url ?? '',
      service: input.service,
      ...(body.data?.price === undefined ? {} : { amount: centavos(body.data.price) }),
    }
  }

  async track(waybill: string): Promise<TrackingEvent[]> {
    const body = await courierFetch<{ data?: { routes?: unknown[] } }>(
      this.options,
      'flash',
      `/open/v1/orders/${encodeURIComponent(waybill)}/routes`,
      { method: 'GET', headers: this.headers() },
    )
    return this.parseWebhook({ pno: waybill, routes: body.data?.routes ?? [] })
  }

  async cancel(waybill: string): Promise<void> {
    await courierFetch(this.options, 'flash', '/open/v1/orders/cancel', {
      method: 'POST',
      headers: this.headers(),
      body: { pno: waybill },
    })
  }

  parseWebhook(payload: unknown): TrackingEvent[] {
    if (payload === null || typeof payload !== 'object') return []
    const body = payload as Record<string, unknown>
    const waybill =
      typeof body['pno'] === 'string'
        ? body['pno']
        : typeof body['tracking_no'] === 'string'
          ? body['tracking_no']
          : ''
    if (waybill === '') return []

    const routes = Array.isArray(body['routes'])
      ? body['routes']
      : // Flash's push webhook sends a single state change rather than a list;
        // normalising it to a one-element list keeps one parsing path.
        [body]

    const events: TrackingEvent[] = []
    for (const entry of routes) {
      if (entry === null || typeof entry !== 'object') continue
      const route = entry as Record<string, unknown>
      const rawCode = String(route['state'] ?? route['status'] ?? '')
      if (rawCode === '') continue

      // Flash sends epoch *seconds*. Treating them as milliseconds puts every
      // parcel in 1970 and makes the timeline sort backwards.
      const at = route['routed_at'] ?? route['timestamp']
      const occurredAt =
        typeof at === 'number'
          ? new Date(at * 1000)
          : typeof at === 'string'
            ? new Date(at)
            : new Date(Number.NaN)
      if (Number.isNaN(occurredAt.getTime())) continue

      events.push({
        waybill,
        status: FLASH_STATUS[rawCode] ?? 'unknown',
        rawCode,
        description: String(route['message'] ?? route['detail'] ?? ''),
        ...(typeof route['city_name'] === 'string' ? { location: route['city_name'] } : {}),
        occurredAt,
        raw: entry,
      })
    }

    return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }
}

/** Exposed for the test that pins the money handling. */
export function flashAmountIsAlreadyCentavos(amount: Centavos): number {
  return amount
}
