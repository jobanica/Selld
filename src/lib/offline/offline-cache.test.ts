import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearQueue,
  clearSnapshots,
  enqueueMove,
  readQueue,
  readSnapshot,
  saveSnapshot,
} from './offline-cache'

describe('offline snapshots', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keys by tenant, so switching stores cannot show the wrong list', () => {
    saveSnapshot('packing', 'tenant-a', [{ orderNumber: '0001' }])
    saveSnapshot('packing', 'tenant-b', [{ orderNumber: '9999' }])

    expect(readSnapshot<{ orderNumber: string }[]>('packing', 'tenant-a')?.data).toEqual([
      { orderNumber: '0001' },
    ])
    expect(readSnapshot<{ orderNumber: string }[]>('packing', 'tenant-b')?.data).toEqual([
      { orderNumber: '9999' },
    ])
  })

  it('stamps when the data was last true, because a stale list has to say so', () => {
    saveSnapshot('packing', 'tenant-a', [])
    const at = readSnapshot('packing', 'tenant-a')?.at
    expect(at).toBeTypeOf('string')
    expect(Number.isNaN(Date.parse(at ?? ''))).toBe(false)
  })

  it('returns null rather than throwing on a corrupted entry', () => {
    // A half-written value survives a crash, and a screen that throws on read is
    // a screen a packer cannot open at all.
    localStorage.setItem('selld.offline.packing.tenant-a', '{not json')
    expect(readSnapshot('packing', 'tenant-a')).toBe(null)
  })

  it('clears everything on sign-out, including screens it was never told about', () => {
    saveSnapshot('packing', 'tenant-a', [1])
    saveSnapshot('customers', 'tenant-b', [2])
    localStorage.setItem('unrelated', 'keep me')

    clearSnapshots()

    expect(readSnapshot('packing', 'tenant-a')).toBe(null)
    expect(readSnapshot('customers', 'tenant-b')).toBe(null)
    // Only ours. Wiping the whole store would take the locale and the tenant
    // switcher's last choice with it.
    expect(localStorage.getItem('unrelated')).toBe('keep me')
  })
})

describe('the pending move queue', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps moves in the order they were made', () => {
    enqueueMove('tenant-a', { orderIds: ['a'], toStatus: 'packed' })
    enqueueMove('tenant-a', { orderIds: ['b'], toStatus: 'packed' })

    const queue = readQueue('tenant-a')
    expect(queue.map((move) => move.orderIds[0])).toEqual(['a', 'b'])
    // Distinct ids, or a flush that dedupes would silently drop one.
    expect(new Set(queue.map((move) => move.id)).size).toBe(2)
  })

  it('is per tenant', () => {
    enqueueMove('tenant-a', { orderIds: ['a'], toStatus: 'packed' })
    expect(readQueue('tenant-b')).toEqual([])
  })

  it('empties on clear', () => {
    enqueueMove('tenant-a', { orderIds: ['a'], toStatus: 'packed' })
    clearQueue('tenant-a')
    expect(readQueue('tenant-a')).toEqual([])
  })
})
