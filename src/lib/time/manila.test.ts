import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatManilaDate,
  formatManilaDateTime,
  formatManilaTime,
  formatRelativeToNow,
  isSameManilaDay,
  manilaDateKey,
  manilaEndOfDay,
  manilaParts,
  manilaStartOfDay,
} from './manila'

describe('manilaDateKey()', () => {
  it('groups by the Manila calendar day, not the UTC day', () => {
    // 2026-07-30 08:00 Manila is 2026-07-30 00:00 UTC — same day either way.
    expect(manilaDateKey('2026-07-30T00:00:00Z')).toBe('2026-07-30')

    // 2026-07-30 07:00 Manila is 2026-07-29 23:00 UTC. A naive UTC date would
    // file this under the 29th and split one Manila morning across two days.
    expect(manilaDateKey('2026-07-29T23:00:00Z')).toBe('2026-07-30')

    // 2026-07-30 23:30 Manila is 2026-07-30 15:30 UTC.
    expect(manilaDateKey('2026-07-30T15:30:00Z')).toBe('2026-07-30')

    // One minute before Manila midnight rolls to the next day.
    expect(manilaDateKey('2026-07-30T16:00:00Z')).toBe('2026-07-31')
  })

  it('sorts lexicographically', () => {
    // Note the first input crosses midnight into the 31st, per the case above.
    const keys = ['2026-07-30T16:00:00Z', '2026-01-05T00:00:00Z', '2026-12-31T00:00:00Z']
      .map(manilaDateKey)
      .sort()
    expect(keys).toEqual(['2026-01-05', '2026-07-31', '2026-12-31'])
  })
})

describe('manilaParts()', () => {
  it('reads the wall clock', () => {
    expect(manilaParts('2026-07-30T01:05:09Z')).toEqual({
      year: 2026,
      month: 7,
      day: 30,
      hour: 9,
      minute: 5,
      second: 9,
    })
  })

  it('reports midnight as hour 0, not 24', () => {
    // 16:00Z is 00:00 Manila the next day.
    expect(manilaParts('2026-07-30T16:00:00Z')).toMatchObject({ day: 31, hour: 0 })
  })
})

describe('manilaStartOfDay() / manilaEndOfDay()', () => {
  it('returns the UTC instant of Manila midnight', () => {
    // Manila midnight on the 30th is 16:00Z on the 29th.
    expect(manilaStartOfDay('2026-07-30T09:00:00Z').toISOString()).toBe(
      '2026-07-29T16:00:00.000Z',
    )
  })

  it('end of day is an exclusive upper bound 24 hours later', () => {
    const start = manilaStartOfDay('2026-07-30T09:00:00Z')
    const end = manilaEndOfDay('2026-07-30T09:00:00Z')
    expect(end.getTime() - start.getTime()).toBe(86_400_000)
    expect(end.toISOString()).toBe('2026-07-30T16:00:00.000Z')
  })

  it('brackets every instant of the same Manila day', () => {
    const reference = '2026-07-30T09:00:00Z'
    const start = manilaStartOfDay(reference)
    const end = manilaEndOfDay(reference)

    // 00:01 and 23:59 Manila both fall inside the window.
    for (const instant of ['2026-07-29T16:01:00Z', '2026-07-30T15:59:00Z']) {
      const time = new Date(instant).getTime()
      expect(time, instant).toBeGreaterThanOrEqual(start.getTime())
      expect(time, instant).toBeLessThan(end.getTime())
    }

    // One minute before the window is the previous Manila day.
    expect(new Date('2026-07-29T15:59:00Z').getTime()).toBeLessThan(start.getTime())
  })
})

describe('isSameManilaDay()', () => {
  it('compares Manila days', () => {
    expect(isSameManilaDay('2026-07-29T23:00:00Z', '2026-07-30T15:00:00Z')).toBe(true)
    expect(isSameManilaDay('2026-07-30T15:00:00Z', '2026-07-30T16:00:00Z')).toBe(false)
  })
})

describe('formatters', () => {
  it('renders Manila wall time regardless of the host timezone', () => {
    expect(formatManilaTime('2026-07-30T01:05:00Z')).toBe('9:05 AM')
    expect(formatManilaDate('2026-07-30T01:05:00Z')).toBe('Jul 30, 2026')
    expect(formatManilaDateTime('2026-07-30T01:05:00Z')).toContain('Jul 30, 2026')
    expect(formatManilaDateTime('2026-07-30T01:05:00Z')).toContain('9:05')
  })

  it('accepts Date, string, and epoch input', () => {
    const iso = '2026-07-30T01:05:00Z'
    const expected = formatManilaDate(iso)
    expect(formatManilaDate(new Date(iso))).toBe(expected)
    expect(formatManilaDate(new Date(iso).getTime())).toBe(expected)
  })

  it('throws on invalid input rather than rendering "Invalid Date"', () => {
    expect(() => formatManilaDate('not a date')).toThrow(RangeError)
  })
})

describe('formatRelativeToNow()', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('describes order-timeline distances', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'))

    expect(formatRelativeToNow('2026-07-30T11:58:00Z')).toBe('2 minutes ago')
    expect(formatRelativeToNow('2026-07-30T10:00:00Z')).toBe('2 hours ago')
    expect(formatRelativeToNow('2026-07-27T12:00:00Z')).toBe('3 days ago')
    expect(formatRelativeToNow('2026-07-30T12:00:30Z')).toBe('in 30 seconds')
    expect(formatRelativeToNow('2026-08-02T12:00:00Z')).toBe('in 3 days')
  })
})
