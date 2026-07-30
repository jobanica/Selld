import { describe, expect, it } from 'vitest'

import {
  describeStockError,
  MANUAL_STOCK_REASONS,
  STOCK_REASONS,
  type StockReason,
} from './inventory-api'

describe('stock reasons', () => {
  /**
   * These must match the database CHECK constraint exactly. A value that
   * typechecks here but is unknown to Postgres fails at runtime, in the middle of a
   * seller's stock-take.
   */
  it('matches the reasons the database accepts', () => {
    const fromMigration: StockReason[] = [
      'sale',
      'return',
      'adjustment',
      'transfer',
      'rts',
      'damage',
      'receive',
    ]
    expect([...STOCK_REASONS].sort()).toEqual([...fromMigration].sort())
  })

  it('never offers `sale` as a manual reason', () => {
    // A sale is written by ship_reservation(), which also releases the reservation.
    // Letting a seller pick it by hand would decrement stock without touching the
    // reservation, so the two would drift apart.
    expect(MANUAL_STOCK_REASONS).not.toContain('sale')
  })

  it('offers the reasons a seller actually needs', () => {
    for (const reason of ['receive', 'adjustment', 'return', 'damage', 'rts'] as const) {
      expect(MANUAL_STOCK_REASONS, reason).toContain(reason)
    }
  })

  it('every manual reason is a valid reason', () => {
    for (const reason of MANUAL_STOCK_REASONS) {
      expect(STOCK_REASONS as readonly string[]).toContain(reason)
    }
  })
})

describe('describeStockError()', () => {
  /**
   * Running out of stock is a business outcome, not a fault — and during a live
   * selling rush it is the single most common one. It must be distinguishable so the
   * UI can say "someone bought it first" instead of showing a database error.
   */
  it('recognises the insufficient-stock case from the RPC', () => {
    expect(
      describeStockError(new Error('Insufficient stock for variant abc (requested 3)')),
    ).toBe('insufficient_stock')
  })

  it('recognises it from the CHECK constraint too, in case the RPC is bypassed', () => {
    expect(
      describeStockError(
        new Error(
          'new row for relation "inventory_levels" violates check constraint "inventory_no_oversell"',
        ),
      ),
    ).toBe('insufficient_stock')
  })

  it('recognises a permission failure', () => {
    expect(describeStockError(new Error('Not allowed to adjust stock for this tenant'))).toBe(
      'not_allowed',
    )
    expect(describeStockError(new Error('permission denied for table inventory_levels'))).toBe(
      'not_allowed',
    )
  })

  it('falls back to `other` for anything unrecognised', () => {
    expect(describeStockError(new Error('connection terminated'))).toBe('other')
    expect(describeStockError('a string')).toBe('other')
    expect(describeStockError(null)).toBe('other')
  })

  it('is case-insensitive — Postgres capitalisation varies by path', () => {
    expect(describeStockError(new Error('INSUFFICIENT STOCK for variant x'))).toBe(
      'insufficient_stock',
    )
  })
})
