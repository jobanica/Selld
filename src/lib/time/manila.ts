/**
 * Everything is stored UTC (`timestamptz`) and displayed in `Asia/Manila`.
 *
 * PH has no daylight saving and has been UTC+08:00 since 1945, so the offset is
 * constant — but we still go through the IANA zone rather than hardcoding +8, so
 * dates stay correct if a seller's device clock or locale is misconfigured.
 *
 * The subtle bug this module exists to prevent: "today's orders" and the daily
 * COD cutoff must be Manila days, not UTC days. A 9am Manila order is 1am UTC
 * *the same day*, but an 8am Manila order is 12am UTC — and a naive UTC
 * `toDateString()` puts orders from the same Manila morning into two buckets.
 */

export const MANILA_TIME_ZONE = 'Asia/Manila'

/**
 * Fixed since 1945 (no DST). Used only to convert a Manila wall-clock date back
 * into a UTC instant — never for formatting, which always goes through Intl.
 */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

export type Instant = Date | string | number

function toDate(value: Instant): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(value)}`)
  }
  return date
}

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`
  let cached = dateTimeFormatCache.get(key)
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, { timeZone: MANILA_TIME_ZONE, ...options })
    dateTimeFormatCache.set(key, cached)
  }
  return cached
}

/** `2026-07-30 14:05` -> `Jul 30, 2026, 2:05 PM` */
export function formatManilaDateTime(value: Instant, locale = 'en-PH'): string {
  return formatter(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(toDate(value))
}

/** `Jul 30, 2026` */
export function formatManilaDate(value: Instant, locale = 'en-PH'): string {
  return formatter(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(
    toDate(value),
  )
}

/** `2:05 PM` */
export function formatManilaTime(value: Instant, locale = 'en-PH'): string {
  return formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(toDate(value))
}

/**
 * The Manila calendar date as `YYYY-MM-DD`. This is the correct grouping key for
 * "today's orders", daily sales, and COD cutoffs.
 */
export function manilaDateKey(value: Instant = new Date()): string {
  // `en-CA` yields ISO-ordered YYYY-MM-DD, which sorts lexicographically.
  return formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    toDate(value),
  )
}

/** Calendar parts as they read on a Manila wall clock. */
export function manilaParts(value: Instant = new Date()): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = formatter('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(toDate(value))

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    return part ? Number(part.value) : 0
  }

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Intl renders midnight as hour 24 in some engines under hour12: false.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  }
}

/** UTC instant of Manila midnight that starts the given day. */
export function manilaStartOfDay(value: Instant = new Date()): Date {
  const { year, month, day } = manilaParts(value)
  return new Date(Date.UTC(year, month - 1, day) - MANILA_OFFSET_MS)
}

/** UTC instant of the first moment of the next Manila day (exclusive end bound). */
export function manilaEndOfDay(value: Instant = new Date()): Date {
  const start = manilaStartOfDay(value)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000)
}

/** True when both instants fall on the same Manila calendar day. */
export function isSameManilaDay(a: Instant, b: Instant): boolean {
  return manilaDateKey(a) === manilaDateKey(b)
}

/** Relative time for order timelines: `2 hours ago`, `in 3 days`. */
export function formatRelativeToNow(value: Instant, locale = 'en-PH'): string {
  const deltaSeconds = Math.round((toDate(value).getTime() - Date.now()) / 1000)
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  // Each entry is the number of this unit that fits in the next one up.
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.34524],
    ['month', 12],
  ]

  let scaled = deltaSeconds
  for (const [unit, perNextUnit] of steps) {
    if (Math.abs(scaled) < perNextUnit) {
      return relative.format(Math.round(scaled), unit)
    }
    scaled /= perNextUnit
  }
  return relative.format(Math.round(scaled), 'year')
}
