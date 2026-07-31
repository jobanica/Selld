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
 * J&T Express Philippines.
 *
 * The largest COD courier for PH social sellers by volume, which is why it is one
 * of the two this phase implements.
 *
 * ## Amounts
 *
 * J&T quotes and collects in **pesos**. Selld is integer centavos everywhere (hard
 * rule 2), so the conversion happens here and nowhere else — same boundary
 * discipline as the Xendit provider, and for the same reason: a centavo of drift
 * between what the courier collects and what the order says is a reconciliation
 * mismatch nobody can explain three weeks later.
 *
 * ## Status vocabulary
 *
 * J&T's codes are mapped into Selld's `TrackingStatus` here so that order logic
 * never learns four couriers' taxonomies. `rawCode` is kept verbatim, because when
 * a seller is arguing with a branch about a parcel, the code on their screen is the
 * one that settles it.
 */

const JNT_STATUS: Record<string, TrackingStatus> = {
  // Codes as they appear in J&T's tracking payloads.
  '1': 'booked',
  '100': 'booked',
  '2': 'picked_up',
  '200': 'picked_up',
  '3': 'in_transit',
  '300': 'in_transit',
  '4': 'out_for_delivery',
  '400': 'out_for_delivery',
  '5': 'delivered',
  '500': 'delivered',
  '6': 'delivery_failed',
  '600': 'delivery_failed',
  '7': 'returning',
  '700': 'returning',
  '8': 'returned',
  '800': 'returned',
  '9': 'cancelled',
  '900': 'cancelled',
}

export interface JntConfig extends CourierHttpOptions {
  /** J&T customer/merchant code. Not a secret — it is printed on manifests. */
  customerCode: string
  apiKey: string
}

function toPesos(amount: Centavos): number {
  if (!Number.isInteger(amount)) {
    throw new RangeError(`Amount must be whole centavos, got ${String(amount)}`)
  }
  return amount / 100
}

/**
 * Pesos back to centavos.
 *
 * `Math.round`, not truncation: `1024.09 * 100` is `102408.99999999999` in
 * IEEE-754, and truncating loses a centavo. Same trap as the Xendit provider, which
 * is why both have a round-trip test over a realistic range.
 */
function toCentavos(amount: number): Centavos {
  return centavos(Math.round(amount * 100))
}

export class JntProvider implements CourierProvider {
  readonly id = 'jnt' as const
  readonly label = 'J&T Express'

  private readonly options: Required<Omit<CourierHttpOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch
  }
  private readonly customerCode: string
  private readonly apiKey: string

  constructor(config: JntConfig) {
    this.customerCode = config.customerCode
    this.apiKey = config.apiKey
    this.options = {
      baseUrl: config.baseUrl,
      fetchImpl: config.fetchImpl ?? globalThis.fetch,
      timeoutMs: config.timeoutMs ?? 15_000,
    }
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      'X-API-Key': this.apiKey,
      'X-Customer-Code': this.customerCode,
      ...(idempotencyKey === undefined ? {} : { 'X-Request-Id': idempotencyKey }),
    }
  }

  async quote(input: QuoteInput): Promise<Rate[]> {
    const body = await courierFetch<{
      rates?: { serviceCode: string; serviceName: string; amount: number; etaDays?: number }[]
    }>(this.options, 'jnt', '/api/rates', {
      method: 'POST',
      headers: this.headers(),
      body: {
        origin: { ...toJntAddress(input.origin) },
        destination: { ...toJntAddress(input.destination) },
        weight: input.parcel.weightGrams / 1000,
        codAmount: input.codAmount === undefined ? 0 : toPesos(input.codAmount),
      },
    })

    return (body.rates ?? []).map((rate) => ({
      provider: 'jnt' as const,
      service: rate.serviceCode,
      serviceLabel: rate.serviceName,
      amount: toCentavos(rate.amount),
      ...(rate.etaDays === undefined ? {} : { etaMinDays: rate.etaDays, etaMaxDays: rate.etaDays }),
    }))
  }

  async book(input: BookInput): Promise<Booking> {
    const body = await courierFetch<{
      waybillNo?: string
      awbNo?: string
      labelUrl?: string
      amount?: number
      serviceCode?: string
    }>(this.options, 'jnt', '/api/orders', {
      method: 'POST',
      // The idempotency key rides as `X-Request-Id` *and* in the body as the
      // merchant reference. J&T de-duplicates on the reference; the header is
      // belt-and-braces for a gateway that retries on our behalf.
      headers: this.headers(input.idempotencyKey),
      body: {
        merchantReference: input.reference,
        requestId: input.idempotencyKey,
        serviceCode: input.service,
        sender: {
          name: input.senderName,
          phone: input.senderPhone,
          ...toJntAddress(input.origin),
        },
        receiver: {
          name: input.recipientName,
          phone: input.recipientPhone,
          ...toJntAddress(input.destination),
        },
        weight: input.parcel.weightGrams / 1000,
        codAmount: input.codAmount === undefined ? 0 : toPesos(input.codAmount),
        declaredValue:
          input.declaredValue === undefined ? undefined : toPesos(input.declaredValue),
        remarks: input.remarks,
      },
    })

    const waybill = body.waybillNo ?? body.awbNo ?? ''
    if (waybill === '') {
      // A 200 with no waybill is worse than an error: it looks like success and
      // leaves an order marked shipped with nothing to track. Treated as a failure.
      throw new Error('J&T accepted the booking but returned no waybill')
    }

    return {
      waybill,
      labelUrl: body.labelUrl ?? '',
      service: body.serviceCode ?? input.service,
      ...(body.amount === undefined ? {} : { amount: toCentavos(body.amount) }),
    }
  }

  async track(waybill: string): Promise<TrackingEvent[]> {
    const body = await courierFetch<{ details?: unknown[] }>(
      this.options,
      'jnt',
      `/api/track/${encodeURIComponent(waybill)}`,
      { method: 'GET', headers: this.headers() },
    )
    return this.parseWebhook({ waybillNo: waybill, details: body.details ?? [] })
  }

  async cancel(waybill: string): Promise<void> {
    await courierFetch(this.options, 'jnt', '/api/orders/cancel', {
      method: 'POST',
      headers: this.headers(),
      body: { waybillNo: waybill },
    })
  }

  parseWebhook(payload: unknown): TrackingEvent[] {
    if (payload === null || typeof payload !== 'object') return []
    const body = payload as Record<string, unknown>
    const waybill =
      typeof body['waybillNo'] === 'string'
        ? body['waybillNo']
        : typeof body['awbNo'] === 'string'
          ? body['awbNo']
          : ''
    if (waybill === '') return []

    const details = Array.isArray(body['details']) ? body['details'] : []
    const events: TrackingEvent[] = []

    for (const entry of details) {
      if (entry === null || typeof entry !== 'object') continue
      const detail = entry as Record<string, unknown>
      const rawCode = String(detail['scanStatus'] ?? detail['status'] ?? '')
      const occurredAtRaw = detail['scanTime'] ?? detail['timestamp']
      const occurredAt =
        typeof occurredAtRaw === 'string' ? new Date(occurredAtRaw) : new Date(Number.NaN)
      if (Number.isNaN(occurredAt.getTime())) continue

      events.push({
        waybill,
        // An unmapped code becomes `unknown` rather than being dropped. A courier
        // adding a status must not make a parcel silently stop moving on screen.
        status: JNT_STATUS[rawCode] ?? 'unknown',
        rawCode,
        description: String(detail['desc'] ?? detail['description'] ?? ''),
        ...(typeof detail['scanNetworkCity'] === 'string'
          ? { location: detail['scanNetworkCity'] }
          : {}),
        occurredAt,
        raw: entry,
      })
    }

    return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }
}

/** PSGC codes plus the free-text street, which is what J&T's API takes. */
function toJntAddress(address: {
  regionCode: string
  provinceCode: string | null
  cityCode: string
  barangayCode: string
  street: string
  postalCode?: string
}): Record<string, string | undefined> {
  return {
    provinceCode: address.provinceCode ?? address.regionCode,
    cityCode: address.cityCode,
    areaCode: address.barangayCode,
    street: address.street,
    postalCode: address.postalCode,
  }
}
