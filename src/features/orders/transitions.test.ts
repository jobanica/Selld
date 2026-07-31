import { describe, expect, it } from 'vitest'

import { NEXT_STATUS, availableActions } from './transitions'
import type { FulfillmentStatus } from './orders-api'

/**
 * The database's ladder, copied from `order_transitions` in
 * `supabase/migrations/20260730001300_orders_dashboard.sql`.
 *
 * Two copies of a rule is how a screen ends up offering a button the server refuses,
 * so this test exists to make the two disagree loudly. If someone adds a transition
 * to the migration and not to `NEXT_STATUS` (or the reverse), this goes red.
 *
 * Written out as the pairs the SQL inserts, not derived from `NEXT_STATUS` — a
 * fixture derived from the thing it checks proves nothing. Same lesson as the
 * phase-7 zone fixture.
 */
const SQL_TRANSITIONS: [FulfillmentStatus, FulfillmentStatus][] = [
  ['pending', 'confirmed'],
  ['pending', 'cancelled'],
  ['confirmed', 'packed'],
  ['confirmed', 'cancelled'],
  ['packed', 'shipped'],
  ['packed', 'confirmed'],
  ['packed', 'cancelled'],
  ['shipped', 'delivered'],
  ['shipped', 'rts'],
  ['rts', 'confirmed'],
]

describe('the fulfilment ladder', () => {
  it('matches the order_transitions table exactly', () => {
    const fromClient = Object.entries(NEXT_STATUS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
      .sort()
    const fromSql = SQL_TRANSITIONS.map(([from, to]) => `${from}->${to}`).sort()

    expect(fromClient).toEqual(fromSql)
  })

  it('has no way out of a terminal state', () => {
    expect(NEXT_STATUS.delivered).toEqual([])
    expect(NEXT_STATUS.cancelled).toEqual([])
  })

  /**
   * Once a parcel is with a courier it exists in the physical world, and the only
   * honest endings are "it arrived" or "it came back". A `shipped -> cancelled`
   * edge would let a seller make a real parcel disappear from every report.
   */
  it('does not allow a shipped order to be cancelled', () => {
    expect(NEXT_STATUS.shipped).not.toContain('cancelled')
  })
})

describe('availableActions', () => {
  const row = (fulfillmentStatus: FulfillmentStatus) => ({ fulfillmentStatus })

  it('offers a single row its own next steps', () => {
    expect(availableActions([row('confirmed')])).toEqual(['packed', 'cancelled'])
  })

  it('offers nothing for an empty selection', () => {
    expect(availableActions([])).toEqual([])
  })

  it('offers the shared steps for a uniform selection', () => {
    expect(availableActions([row('confirmed'), row('confirmed'), row('confirmed')])).toEqual([
      'packed',
      'cancelled',
    ])
  })

  /**
   * The intersection, not the union, and this is the case that matters.
   *
   * A bulk action is one call for the whole batch. Offering "mark shipped" for a
   * selection that is half confirmed would move the packed half and silently skip
   * the rest — the seller taps once, reads "25 moved, 25 skipped", and is left to
   * work out which twenty-five and why.
   */
  it('offers only what every selected row can do', () => {
    expect(availableActions([row('confirmed'), row('packed')])).toEqual(['cancelled'])
    expect(availableActions([row('confirmed'), row('packed')])).not.toContain('shipped')
    expect(availableActions([row('confirmed'), row('packed')])).not.toContain('packed')
  })

  it('offers nothing when one row is terminal', () => {
    expect(availableActions([row('confirmed'), row('delivered')])).toEqual([])
  })

  it('offers nothing across statuses with no shared next step', () => {
    expect(availableActions([row('pending'), row('shipped')])).toEqual([])
  })
})
