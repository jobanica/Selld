import type { Centavos } from '@/lib/money'

/**
 * `SmsProvider` — Semaphore first (PH A2P).
 *
 * SMS is a resold cost centre: we pay ~₱0.30 and charge ₱0.50, tracked in
 * `sms_credit_ledger`. So `cost` is part of the send result, not an afterthought —
 * every send must be attributable to a tenant and a purpose for margin
 * reporting and for the per-message cost preview before a broadcast goes out.
 */

export type SmsProviderId = 'semaphore' | 'log'

/** Why a message was sent. Drives ledger reason codes and cost attribution. */
export type SmsPurpose = 'tracking' | 'otp' | 'broadcast' | 'abandoned_cart' | 'test'

export interface SendSmsInput {
  /** E.164, already normalised by `parsePhPhone`. Mobile only. */
  to: string
  body: string
  purpose: SmsPurpose
  /** Registered sender name. PH A2P requires pre-registration. */
  senderName?: string
  idempotencyKey: string
}

export type SmsStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected'

export interface SmsResult {
  provider: SmsProviderId
  providerRef: string
  to: string
  status: SmsStatus
  /** What the provider charged us. Retail markup is applied by the ledger. */
  cost: Centavos
  /** Multipart messages bill per segment; a 200-char Taglish blast is 2. */
  segments: number
}

export interface SmsDeliveryEvent {
  providerRef: string
  to: string
  status: SmsStatus
  error?: string
  occurredAt: Date
  externalId: string
  raw: unknown
}

export interface SmsProvider {
  readonly id: SmsProviderId
  readonly label: string

  send(input: SendSmsInput): Promise<SmsResult>

  sendBatch(inputs: readonly SendSmsInput[]): Promise<SmsResult[]>

  /**
   * Segment count and cost for a body, without sending.
   *
   * Needed for the "cost shown upfront" requirement on broadcasts. Taglish copy
   * routinely contains `ñ` and emoji, which force UCS-2 encoding and halve the
   * per-segment character budget — so this must inspect the actual body rather
   * than assume 160 characters.
   */
  estimate(body: string): { segments: number; cost: Centavos; encoding: 'gsm7' | 'ucs2' }

  parseDeliveryWebhook(payload: unknown): SmsDeliveryEvent[]
}
