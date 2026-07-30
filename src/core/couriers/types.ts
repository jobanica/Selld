import type { Centavos } from '@/lib/money'

/**
 * `CourierProvider` — the shape every courier integration implements.
 *
 * Mirrors Servd's `DeliveryProvider`. The contract exists so that adding LBC or
 * Ninja Van after J&T and Flash touches exactly one new file and one registry
 * line, and zero lines of order logic.
 */

export type CourierId = 'jnt' | 'flash' | 'lbc' | 'ninja'

/** A PSGC-addressed destination. Barangay matters — couriers price on it. */
export interface CourierAddress {
  regionCode: string
  provinceCode: string | null
  cityCode: string
  barangayCode: string
  street: string
  postalCode?: string
  landmark?: string
}

export interface Parcel {
  weightGrams: number
  lengthCm?: number
  widthCm?: number
  heightCm?: number
}

export interface QuoteInput {
  origin: CourierAddress
  destination: CourierAddress
  parcel: Parcel
  /** Amount to collect on delivery. Absent or zero means prepaid. */
  codAmount?: Centavos
  declaredValue?: Centavos
}

export interface Rate {
  provider: CourierId
  /** Provider's service code, e.g. `standard`, `next-day`. */
  service: string
  serviceLabel: string
  amount: Centavos
  /** Estimated transit time, in days. */
  etaMinDays?: number
  etaMaxDays?: number
  /** Set when the provider quoted a COD handling fee separately. */
  codFee?: Centavos
}

export interface BookInput {
  /** Our order number, printed on the label so packers can match parcels. */
  reference: string
  origin: CourierAddress
  destination: CourierAddress
  senderName: string
  senderPhone: string
  recipientName: string
  recipientPhone: string
  parcel: Parcel
  service: string
  codAmount?: Centavos
  declaredValue?: Centavos
  /** Free-text note printed on the waybill, e.g. handling instructions. */
  remarks?: string
  /** Stable key so a retried booking does not create a second parcel. */
  idempotencyKey: string
}

export interface Booking {
  waybill: string
  /** URL to a printable label. Merged into one PDF for bulk booking. */
  labelUrl: string
  service: string
  /** Rate the provider actually charged, when it returns one at booking time. */
  amount?: Centavos
}

/**
 * A normalised tracking event.
 *
 * `status` is Selld's vocabulary, not the courier's — each provider maps its own
 * status codes into this set so order fulfilment logic never learns four
 * different taxonomies. `rawCode` is preserved for support and debugging.
 */
export type TrackingStatus =
  | 'booked'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'cancelled'
  | 'unknown'

export interface TrackingEvent {
  waybill: string
  status: TrackingStatus
  /** The courier's own status code, kept verbatim. */
  rawCode: string
  description: string
  location?: string
  occurredAt: Date
  raw: unknown
}

export interface CourierProvider {
  readonly id: CourierId
  readonly label: string

  /** Rate options for a destination. Used by `courier_live` shipping rates. */
  quote(input: QuoteInput): Promise<Rate[]>

  /** Create a shipment and return its waybill. Must honour `idempotencyKey`. */
  book(input: BookInput): Promise<Booking>

  track(waybill: string): Promise<TrackingEvent[]>

  cancel(waybill: string): Promise<void>

  /**
   * Convert a webhook body into tracking events.
   *
   * Synchronous and pure: parsing must not depend on network access, so a
   * malformed payload can be replayed from `webhook_events` and re-parsed after
   * a fix without re-contacting the courier.
   */
  parseWebhook(payload: unknown): TrackingEvent[]
}
