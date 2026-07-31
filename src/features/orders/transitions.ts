import type { FulfillmentStatus } from './orders-api'

/**
 * The fulfilment ladder, client side.
 *
 * The authoritative copy is the `order_transitions` table, and `order_detail`
 * returns the allowed set per order so the detail view never guesses. This copy
 * exists for the *list*, which deliberately does not fetch a detail per row — fifty
 * detail calls to decide which buttons to draw would cost more than the batch move
 * itself.
 *
 * It is kept deliberately no wider than the database's set. Offering too little is a
 * small annoyance; offering an action the server refuses means the seller taps it,
 * reads "0 moved, 50 skipped", and has to work out why on their own.
 *
 * `transitions.test.ts` pins this against the SQL fixture, so the two cannot drift
 * silently.
 */
export const NEXT_STATUS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  // `confirmed` is the unpack path: a packer who picked the wrong item puts it back.
  packed: ['shipped', 'confirmed', 'cancelled'],
  // Once a parcel is with a courier the terminal states are delivered or RTS.
  // Letting it be "cancelled" here would lose a real parcel from every report.
  shipped: ['delivered', 'rts'],
  delivered: [],
  rts: ['confirmed'],
  cancelled: [],
}

/**
 * What a whole selection may be moved to: the intersection across its rows.
 *
 * Intersection rather than union, because a bulk action is one call for the batch.
 * A union would offer "mark shipped" for a selection that is half confirmed, move
 * the packed half, and silently skip the rest.
 */
export function availableActions(
  rows: readonly { fulfillmentStatus: FulfillmentStatus }[],
): FulfillmentStatus[] {
  if (rows.length === 0) return []
  return rows
    .map((row) => NEXT_STATUS[row.fulfillmentStatus])
    .reduce((intersection, next) => intersection.filter((status) => next.includes(status)))
}
