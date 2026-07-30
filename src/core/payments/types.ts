import type { Centavos } from '@/lib/money'

/**
 * `PaymentProvider` — same shape discipline as couriers.
 *
 * COD is modelled as a payment method rather than an absence of payment. It has
 * a lifecycle (collected by rider, remitted by courier, reconciled against a
 * statement) that the order must be able to represent, which is exactly what
 * phase 12's reconciliation depends on.
 */

export type PaymentProviderId = 'xendit' | 'cod' | 'manual'

export type PaymentMethod = 'cod' | 'gcash' | 'maya' | 'grabpay' | 'card' | 'bank' | 'qrph'

export type PaymentStatus =
  | 'pending'
  /** Buyer sent us to the provider; awaiting their action. */
  | 'awaiting_action'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'partially_refunded'

export interface ChargeInput {
  /** Our order number — appears on the buyer's bank/e-wallet statement. */
  reference: string
  amount: Centavos
  method: PaymentMethod
  customerName: string
  customerPhone: string
  customerEmail?: string
  /** Where the provider returns the buyer after a successful payment. */
  successUrl: string
  failureUrl: string
  /** Invoice expiry. Short windows reduce abandoned-but-locked inventory. */
  expiresInSeconds?: number
  idempotencyKey: string
}

export interface Charge {
  provider: PaymentProviderId
  /** Provider's id for this charge, stored as `payments.provider_ref`. */
  providerRef: string
  status: PaymentStatus
  /** Where to send the buyer to complete payment. Absent for COD. */
  checkoutUrl?: string
  amount: Centavos
  /** Provider fee, when known at creation. Often only known on settlement. */
  feeCentavos?: Centavos
  expiresAt?: Date
}

export interface RefundInput {
  providerRef: string
  amount: Centavos
  reason: string
  idempotencyKey: string
}

export interface Refund {
  providerRef: string
  amount: Centavos
  status: 'pending' | 'succeeded' | 'failed'
}

/** A payment state change parsed from a webhook. */
export interface PaymentEvent {
  providerRef: string
  reference: string
  status: PaymentStatus
  amount: Centavos
  feeCentavos?: Centavos
  method?: PaymentMethod
  paidAt?: Date
  /** Stable id for `webhook_events.external_id` de-duplication. */
  externalId: string
  raw: unknown
}

export interface PaymentProvider {
  readonly id: PaymentProviderId
  readonly label: string
  readonly supportedMethods: readonly PaymentMethod[]

  createCharge(input: ChargeInput): Promise<Charge>

  getCharge(providerRef: string): Promise<Charge>

  refund(input: RefundInput): Promise<Refund>

  /**
   * Verify a webhook's authenticity before it is trusted.
   *
   * Separate from parsing and mandatory: an unverified payment webhook is a
   * "mark any order paid" endpoint. Returns false rather than throwing so the
   * caller logs and 401s uniformly.
   */
  verifyWebhook(input: {
    rawBody: string
    headers: Record<string, string | undefined>
  }): boolean

  parseWebhook(payload: unknown): PaymentEvent[]
}
