/**
 * Sending a message back to a buyer on the channel they commented from.
 *
 * A `MessengerProvider` is deliberately thinner than `SmsProvider`: there is no
 * cost model and no segment arithmetic, because a Messenger reply is free and the
 * constraint is Facebook's 24-hour window rather than a per-message charge.
 *
 * The interface exists in phase 13 and its only implementation logs. The real Send
 * API call needs a page access token, which needs OAuth, which is phase 14 — and
 * registering the real provider there must not change a line of the live-selling
 * code. That is the whole reason this is a port and not a function call.
 */

export interface OutboundMessage {
  /** Page-scoped user id. The buyer, on this page only. */
  psid: string
  text: string
  /**
   * Why this is being sent, for the log and for Facebook's message tags.
   *
   * A claim confirmation is a reply to something the buyer did seconds ago, so it
   * sits inside the standard messaging window; a reminder that a hold is about to
   * expire may not, and that is the distinction the tag has to carry.
   */
  purpose: 'live_claim' | 'live_expiring' | 'live_expired'
  /** Stable per (claim, purpose), so a retry cannot double-send. */
  idempotencyKey: string
}

export interface MessengerResult {
  provider: string
  status: 'sent' | 'failed' | 'skipped'
  providerRef?: string | null
  error?: string
}

export interface MessengerProvider {
  readonly id: string
  send(message: OutboundMessage): Promise<MessengerResult>
}
