/**
 * When a store takes orders.
 *
 * A storefront never literally closes — the page is up at 3am and the cart still
 * works — so these are *order* hours: when the seller is at their phone, packing
 * and replying. That is the thing a buyer actually wants to know before they send
 * a screenshot of their GCash receipt and start waiting, and it is the number one
 * question in a social seller's inbox.
 *
 * Two consequences shape everything below.
 *
 * **Publishing is opt-in.** `enabled` starts false, and a store that never set
 * hours shows none rather than showing a default somebody else picked. A wrong
 * "Closed" on a shop that is in fact taking orders costs a sale in the one moment
 * the buyer was ready to buy.
 *
 * **"Open now" is not computed here.** It is computed once, in SQL, and arrives
 * in the storefront payload — see `storefront_store_policies`. Deriving it in the
 * browser would mean the server rendered one answer and the client hydrated with
 * another whenever a minute ticked between the two, and on this surface a
 * hydration mismatch throws away the entire server-rendered tree. The formatting
 * in this file is pure string work over `HH:MM`, so it is identical on both sides
 * by construction.
 */

/** One day's window, as a Manila wall clock. */
export interface DayHours {
  /** `HH:MM`, 24-hour. */
  open: string
  /** `HH:MM`. Less than or equal to `open` means the window crosses midnight. */
  close: string
}

/**
 * Monday-first, seven entries. `null` is a closed day.
 *
 * Monday-first rather than the Sunday-first of a PH wall calendar, because these
 * read as a working week — "Mon–Sat" is one range this way and two the other.
 */
export type WeekHours = readonly [
  DayHours | null,
  DayHours | null,
  DayHours | null,
  DayHours | null,
  DayHours | null,
  DayHours | null,
  DayHours | null,
]

export interface StoreHours {
  /** Whether buyers see any of this. Off until the seller turns it on. */
  enabled: boolean
  days: WeekHours
  /** One line under the week — "Sarado tuwing holiday", "Same-day cutoff 3PM". */
  note: string
}

/** Monday-first indices, for anything that needs to label a day. */
export const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Mon–Sat 9–6, Sunday off — the shape of a working week for the seller this is
 * built for. Inert until `enabled`, so it is a starting point in the editor
 * rather than a claim on the storefront.
 */
export const DEFAULT_STORE_HOURS: StoreHours = {
  enabled: false,
  days: [
    { open: '09:00', close: '18:00' },
    { open: '09:00', close: '18:00' },
    { open: '09:00', close: '18:00' },
    { open: '09:00', close: '18:00' },
    { open: '09:00', close: '18:00' },
    { open: '09:00', close: '18:00' },
    null,
  ],
  note: '',
}

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value)
}

/** `09:30` -> 570. */
export function minutesOfDay(value: string): number {
  const hour = Number(value.slice(0, 2))
  const minute = Number(value.slice(3, 5))
  return hour * 60 + minute
}

/**
 * `18:00` -> `6:00 PM`.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`, and deliberately: recent ICU
 * versions put a narrow no-break space before the meridiem and older ones a
 * plain space. Node and the browser can disagree on that one character, which on
 * a server-rendered surface is a hydration mismatch — invisible in a diff, and it
 * discards the whole tree.
 */
export function formatTime12(value: string): string {
  if (!isValidTime(value)) return value
  const hour = Number(value.slice(0, 2))
  const minute = value.slice(3, 5)
  const meridiem = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${String(hour12)}:${minute} ${meridiem}`
}

function parseDay(raw: unknown): DayHours | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const open = record.open
  const close = record.close
  if (typeof open !== 'string' || typeof close !== 'string') return undefined
  if (!isValidTime(open) || !isValidTime(close)) return undefined
  return { open, close }
}

/**
 * Parse an untrusted `tenant_settings` value.
 *
 * Returns `undefined` for anything it cannot trust, and the caller substitutes
 * the default — the same contract every other setting parser has. A half-valid
 * week is rejected whole rather than patched, because a silently repaired
 * schedule is a schedule the seller believes they set and did not.
 */
export function parseStoreHours(raw: unknown): StoreHours | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>

  const enabled = record.enabled
  if (typeof enabled !== 'boolean') return undefined

  const note = record.note ?? ''
  if (typeof note !== 'string' || note.length > 160) return undefined

  const days = record.days
  if (!Array.isArray(days) || days.length !== 7) return undefined

  const parsed: (DayHours | null)[] = []
  for (const day of days) {
    const value = parseDay(day)
    if (value === undefined) return undefined
    parsed.push(value)
  }

  return {
    enabled,
    days: parsed as unknown as WeekHours,
    note,
  }
}

export interface WeekRun {
  /** Monday-first index of the first day in the run. */
  from: number
  /** Monday-first index of the last day, inclusive. Equal to `from` for one day. */
  to: number
  hours: DayHours | null
}

/**
 * Collapse the week into runs of identical days.
 *
 * `Mon–Sat 9:00 AM – 6:00 PM` and `Sun Closed` rather than seven lines saying
 * almost the same thing. Only *consecutive* days merge — a store closed on
 * Wednesday genuinely has three runs, and flattening that into "Mon–Sat except
 * Wed" is how a buyer turns up on the wrong day.
 */
export function summariseWeek(days: WeekHours): WeekRun[] {
  const runs: WeekRun[] = []
  for (let index = 0; index < 7; index += 1) {
    const day = days[index] ?? null
    const previous = runs[runs.length - 1]
    if (previous !== undefined && sameDay(previous.hours, day)) {
      previous.to = index
    } else {
      runs.push({ from: index, to: index, hours: day })
    }
  }
  return runs
}

function sameDay(a: DayHours | null, b: DayHours | null): boolean {
  if (a === null || b === null) return a === b
  return a.open === b.open && a.close === b.close
}

/** True when the window runs past midnight into the next day. */
export function crossesMidnight(day: DayHours): boolean {
  return minutesOfDay(day.close) <= minutesOfDay(day.open)
}
