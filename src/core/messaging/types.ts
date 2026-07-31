/**
 * Sending a message back to a buyer on the channel they commented from.
 *
 * A `MessengerProvider` is deliberately thinner than `SmsProvider`: there is no
 * cost model and no segment arithmetic, because a Messenger reply is free and the
 * constraint is Facebook's 24-hour window rather than a per-message charge.
 *
 * Phase 13 wrote the port and one implementation that logs. Phase 14 adds the real
 * Send API implementation behind the same interface, which is why the live-selling
 * code that calls it did not have to learn what a page access token is.
 */

/**
 * Why this is being sent — for the log, and for Facebook's message tags.
 *
 * The distinction the tag has to carry: a claim confirmation is a reply to
 * something the buyer did seconds ago and sits inside the standard messaging
 * window; a reminder that a hold is about to expire may not.
 */
export type MessagePurpose =
  | 'live_claim'
  | 'live_expiring'
  | 'live_expired'
  /** A keyword rule fired. Automated, so it may never claim a human-agent tag. */
  | 'auto_reply'
  /** The private reply to a public comment — the "check your inbox" play. */
  | 'comment_reply'
  /** A person typed it in the inbox. */
  | 'agent_reply'

export interface OutboundMessage {
  /** Page-scoped user id. The buyer, on this page only. */
  psid: string
  text: string
  purpose: MessagePurpose
  /** Stable per (claim, purpose), so a retry cannot double-send. */
  idempotencyKey: string
  /**
   * Which page is speaking.
   *
   * A PSID is meaningless without it — the same human on two Pages is two ids —
   * and the token is per page, so a provider with no page id has nothing to send
   * from and says so rather than guessing.
   */
  pageId?: string | null
  /** Tenant the send belongs to, for `integration_logs`. */
  tenantId?: string | null
  /**
   * Facebook message tag, when the send is outside the 24-hour window.
   *
   * The database has already decided this — `message_send_allowed()` is what
   * refuses — so a provider treats it as instruction, not as a request to
   * re-litigate.
   */
  tag?: string | null
  /**
   * Send this as a *private reply to a comment* rather than as a message.
   *
   * A different endpoint, and the only send that needs no open window: the person
   * just commented publicly. Exactly one per comment — Facebook refuses the second,
   * which is why `post_comments` deduplicates before anything is sent.
   */
  replyToCommentId?: string | null
}

export interface MessengerResult {
  provider: string
  status: 'sent' | 'failed' | 'skipped'
  providerRef?: string | null
  error?: string
  /**
   * Whether a failure is worth another attempt later.
   *
   * A policy refusal is not: retrying one is how a page loses its messaging
   * permission, which for a seller whose business runs through Messenger is the
   * business.
   */
  retryable?: boolean
}

export interface MessengerProvider {
  readonly id: string
  send(message: OutboundMessage): Promise<MessengerResult>
}
