import { describe, expect, it } from 'vitest'

import {
  crossesMidnight,
  DEFAULT_STORE_HOURS,
  formatTime12,
  minutesOfDay,
  parseStoreHours,
  summariseWeek,
  type WeekHours,
} from './store-hours'

const CLOSED_WEEK: WeekHours = [null, null, null, null, null, null, null]

function week(...days: (string | null)[]): WeekHours {
  return days.map((day) =>
    day === null ? null : { open: day.slice(0, 5), close: day.slice(6) },
  ) as unknown as WeekHours
}

describe('parseStoreHours', () => {
  it('accepts a well-formed week', () => {
    const parsed = parseStoreHours({
      enabled: true,
      days: [...week('09:00-18:00', '09:00-18:00', null, null, null, null, null)],
      note: 'Sarado tuwing holiday',
    })
    expect(parsed?.enabled).toBe(true)
    expect(parsed?.days[0]).toEqual({ open: '09:00', close: '18:00' })
    expect(parsed?.days[2]).toBeNull()
    expect(parsed?.note).toBe('Sarado tuwing holiday')
  })

  it('defaults the note when it is absent', () => {
    expect(parseStoreHours({ enabled: false, days: [...CLOSED_WEEK] })?.note).toBe('')
  })

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['a missing enabled flag', { days: [...CLOSED_WEEK] }],
    ['a six-day week', { enabled: true, days: [null, null, null, null, null, null] }],
    ['an eight-day week', { enabled: true, days: [...CLOSED_WEEK, null] }],
    ['a 24-hour clock overflow', { enabled: true, days: [...week('24:00-25:00'), null, null, null, null, null, null] }],
    ['a minute overflow', { enabled: true, days: [...week('09:70-18:00'), null, null, null, null, null, null] }],
    ['a single-digit hour', { enabled: true, days: [...week('9:00-18:00'), null, null, null, null, null, null] }],
    ['a half-written day', { enabled: true, days: [{ open: '09:00' }, null, null, null, null, null, null] }],
  ])('rejects %s', (_label, raw) => {
    expect(parseStoreHours(raw)).toBeUndefined()
  })

  it('rejects a whole week when one day is malformed', () => {
    // Whole rather than patched: a silently repaired schedule is a schedule the
    // seller believes they set and did not.
    expect(
      parseStoreHours({
        enabled: true,
        days: [
          { open: '09:00', close: '18:00' },
          { open: '09:00', close: 'noon' },
          null,
          null,
          null,
          null,
          null,
        ],
      }),
    ).toBeUndefined()
  })

  it('round-trips the default through JSON, which is how it reaches the database', () => {
    expect(parseStoreHours(JSON.parse(JSON.stringify(DEFAULT_STORE_HOURS)))).toEqual(
      DEFAULT_STORE_HOURS,
    )
  })

  it('publishes nothing by default', () => {
    expect(DEFAULT_STORE_HOURS.enabled).toBe(false)
  })
})

describe('formatTime12', () => {
  it.each([
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['09:00', '9:00 AM'],
    ['11:59', '11:59 AM'],
    ['12:00', '12:00 PM'],
    ['12:05', '12:05 PM'],
    ['13:00', '1:00 PM'],
    ['18:00', '6:00 PM'],
    ['23:59', '11:59 PM'],
  ])('renders %s as %s', (input, expected) => {
    expect(formatTime12(input)).toBe(expected)
  })

  it('separates the meridiem with a plain space', () => {
    // A narrow no-break space here is a hydration mismatch: Node's ICU and the
    // browser's disagree on it, and this surface is server-rendered.
    expect(formatTime12('18:00')).toBe('6:00 PM')
    expect(formatTime12('18:00').charCodeAt(4)).toBe(32)
  })
})

describe('minutesOfDay', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['23:59', 1439],
  ])('reads %s as %i', (input, expected) => {
    expect(minutesOfDay(input)).toBe(expected)
  })
})

describe('crossesMidnight', () => {
  it('is false for an ordinary day', () => {
    expect(crossesMidnight({ open: '09:00', close: '18:00' })).toBe(false)
  })

  it('is true for a live-selling night that runs past midnight', () => {
    expect(crossesMidnight({ open: '20:00', close: '02:00' })).toBe(true)
  })

  it('treats an equal pair as a wrap rather than a zero-length day', () => {
    expect(crossesMidnight({ open: '09:00', close: '09:00' })).toBe(true)
  })
})

describe('summariseWeek', () => {
  it('collapses a Mon-Sat week into two runs', () => {
    const runs = summariseWeek(
      week(
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        null,
      ),
    )
    expect(runs).toEqual([
      { from: 0, to: 5, hours: { open: '09:00', close: '18:00' } },
      { from: 6, to: 6, hours: null },
    ])
  })

  it('does not merge across a closed day in the middle', () => {
    // "Mon-Sat except Wed" is how a buyer turns up on the wrong day.
    const runs = summariseWeek(
      week('09:00-18:00', '09:00-18:00', null, '09:00-18:00', '09:00-18:00', null, null),
    )
    expect(runs.map((run) => [run.from, run.to])).toEqual([
      [0, 1],
      [2, 2],
      [3, 4],
      [5, 6],
    ])
  })

  it('does not merge days whose windows differ', () => {
    const runs = summariseWeek(
      week(
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '09:00-18:00',
        '10:00-16:00',
        null,
      ),
    )
    expect(runs).toHaveLength(3)
    expect(runs[1]).toEqual({ from: 5, to: 5, hours: { open: '10:00', close: '16:00' } })
  })

  it('returns one run for a week that never opens', () => {
    expect(summariseWeek(CLOSED_WEEK)).toEqual([{ from: 0, to: 6, hours: null }])
  })

  it('covers all seven days exactly once', () => {
    const runs = summariseWeek(
      week('09:00-18:00', null, '09:00-18:00', null, '09:00-18:00', null, '09:00-18:00'),
    )
    expect(runs[0]?.from).toBe(0)
    expect(runs[runs.length - 1]?.to).toBe(6)
    for (let index = 1; index < runs.length; index += 1) {
      expect(runs[index]?.from).toBe((runs[index - 1]?.to ?? -1) + 1)
    }
  })
})
