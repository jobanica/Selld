/**
 * Idempotency keys for outbound calls, and event de-duplication for inbound
 * webhooks.
 *
 * Both directions matter and they are not the same problem:
 *
 *  - **Outbound**: booking the same order twice creates two waybills and two
 *    parcels for one order. The key must be stable across retries *and across
 *    process restarts*, so it is derived from the business entity rather than
 *    generated randomly.
 *
 *  - **Inbound**: Xendit and the couriers all retry webhooks and all deliver
 *    duplicates. `webhook_events.external_id` carries a unique constraint, and
 *    the handler is a no-op when the insert conflicts. That is what makes
 *    "replaying the same webhook twice changes nothing" true by construction
 *    instead of by careful coding.
 */

export interface IdempotencyKeyInput {
  tenantId: string
  /** Operation name, e.g. `shipment.book`, `payment.charge`. */
  operation: string
  /** The entity the operation acts on, e.g. an order id. */
  entityId: string
  /**
   * Bump when a *deliberate* retry should be treated as a new request — for
   * example rebooking after a cancellation. Defaults to 0.
   */
  attemptEpoch?: number
}

/**
 * Deterministic key: same inputs always produce the same key, so a retry after a
 * crash is recognised by the provider as the same request.
 *
 * Kept human-readable rather than hashed — when a seller reports a duplicate
 * parcel, being able to grep provider logs for the order id is worth more than
 * a compact key.
 */
export function idempotencyKey({
  tenantId,
  operation,
  entityId,
  attemptEpoch = 0,
}: IdempotencyKeyInput): string {
  const parts = [tenantId, operation, entityId, String(attemptEpoch)]
  if (parts.some((part) => part === '' || part.includes('|'))) {
    throw new Error(
      `Invalid idempotency key part in ${JSON.stringify(parts)} — parts must be non-empty and contain no "|"`,
    )
  }
  return parts.join('|')
}

/**
 * Stable identity for an inbound webhook, used as `webhook_events.external_id`.
 *
 * Providers vary in what they give us: Xendit sends an event id, some couriers
 * only send status transitions. When there is no natural id, compose one from
 * the fields that make the event unique so redelivery still collapses.
 */
export function webhookEventId(provider: string, externalId: string): string {
  if (provider === '' || externalId === '') {
    throw new Error('webhookEventId requires a non-empty provider and externalId')
  }
  return `${provider}:${externalId}`
}

/** Compose an id for providers that do not supply an event id of their own. */
export function syntheticWebhookEventId(
  provider: string,
  parts: readonly (string | number)[],
): string {
  if (parts.length === 0) throw new Error('syntheticWebhookEventId requires at least one part')
  return webhookEventId(provider, parts.map(String).join(':'))
}
