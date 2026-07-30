/**
 * Money in Selld is always an integer number of centavos. Never a float.
 *
 * Postgres stores these as `bigint`. JavaScript numbers are exact integers up to
 * 2^53-1, which is ₱90,071,992,547,409.91 — far beyond any plausible order, so
 * `number` is safe here as long as every value stays an integer. The `Centavos`
 * brand exists to make "did I already convert this from pesos?" a compile-time
 * question instead of a production incident.
 *
 * Rounding is half-away-from-zero (₱0.005 -> ₱0.01, -₱0.005 -> -₱0.01). This
 * matches how PH invoices and courier rate cards round, and keeps refunds
 * symmetric with the charges they reverse.
 */

declare const centavosBrand: unique symbol

/** An integer count of centavos. Construct with {@link centavos} or {@link pesos}. */
export type Centavos = number & { readonly [centavosBrand]: 'Centavos' }

/** Basis points (1/100th of a percent). 250 bps = 2.5%. */
declare const bpsBrand: unique symbol
export type Bps = number & { readonly [bpsBrand]: 'Bps' }

export const MAX_SAFE_CENTAVOS = Number.MAX_SAFE_INTEGER
export const ZERO = 0 as Centavos

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function isCentavos(value: unknown): value is Centavos {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** Wrap an integer centavo count. Throws if it is not a safe integer. */
export function centavos(value: number): Centavos {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Centavos must be finite, got ${value}`)
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Centavos must be a whole number, got ${value}. Use pesos() to convert from a peso amount.`,
    )
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Centavos ${value} exceeds the safe integer range`)
  }
  return value as Centavos
}

/**
 * Parse a peso amount into centavos. Accepts what a seller actually types:
 * `1234.5`, `"1,234.56"`, `"₱1,234"`, `" 1234 "`, `"-50.25"`.
 *
 * Returns `null` rather than throwing so callers can render a field-level error.
 * Rejects more than 2 decimal places instead of silently rounding — if a seller
 * types `199.999` we want to ask what they meant, not pick for them.
 */
export function parsePesos(input: string | number): Centavos | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    // Round-trip through a fixed-precision string so 19.99 does not become 1998.
    return parsePesos(input.toFixed(10).replace(/0+$/, '').replace(/\.$/, ''))
  }

  const cleaned = input.trim().replace(/[₱\s,_]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null
  if (!/^[+-]?\d*(\.\d*)?$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const unsigned = cleaned.replace(/^[+-]/, '')
  const [whole = '', fraction = ''] = unsigned.split('.')
  if (whole === '' && fraction === '') return null
  if (fraction.length > 2) return null

  const centavoDigits = fraction.padEnd(2, '0')
  const combined = `${whole || '0'}${centavoDigits}`
  const magnitude = Number(combined)
  if (!Number.isSafeInteger(magnitude)) return null

  const result = negative ? -magnitude : magnitude
  // Normalise -0 to 0 so equality checks behave.
  return (result === 0 ? 0 : result) as Centavos
}

/** Strict {@link parsePesos}. Throws on invalid input. */
export function pesos(input: string | number): Centavos {
  const parsed = parsePesos(input)
  if (parsed === null) {
    throw new MoneyError(`Cannot parse "${String(input)}" as a peso amount`)
  }
  return parsed
}

/** Basis points from a percentage. `bpsFromPercent(2.5)` -> 250. */
export function bpsFromPercent(percent: string | number): Bps {
  // Reuse the peso parser: both are "a decimal with at most 2 places, scaled by
  // 100", so 2.5% and ₱2.50 have identical parsing rules.
  const parsed = parsePesos(percent)
  if (parsed === null) {
    throw new MoneyError(`Cannot parse "${String(percent)}" as a percentage`)
  }
  return parsed as number as Bps
}

export function bps(value: number): Bps {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Basis points must be a whole number, got ${value}`)
  }
  return value as Bps
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(...values: Centavos[]): Centavos {
  let total = 0
  for (const value of values) total += value
  return centavos(total)
}

export function subtract(a: Centavos, b: Centavos): Centavos {
  return centavos(a - b)
}

export function negate(value: Centavos): Centavos {
  return centavos(value === 0 ? 0 : -value)
}

export function abs(value: Centavos): Centavos {
  return centavos(Math.abs(value))
}

export function sum(values: readonly Centavos[]): Centavos {
  let total = 0
  for (const value of values) total += value
  return centavos(total)
}

/** Multiply by a whole-number quantity (line item: unit price x qty). */
export function multiplyByQty(value: Centavos, qty: number): Centavos {
  if (!Number.isSafeInteger(qty)) {
    throw new MoneyError(`Quantity must be a whole number, got ${qty}`)
  }
  const product = BigInt(value) * BigInt(qty)
  return bigIntToCentavos(product)
}

/**
 * Apply a basis-point rate, rounding half away from zero.
 *
 * This is the one place COD fees, payment fees, and percentage discounts get
 * computed, so the rounding rule lives here and nowhere else.
 */
export function applyBps(value: Centavos, rate: Bps): Centavos {
  return divideRounded(BigInt(value) * BigInt(rate), 10_000n)
}

/** Convenience wrapper: `applyPercent(x, 2.5)` == `applyBps(x, bps(250))`. */
export function applyPercent(value: Centavos, percent: string | number): Centavos {
  return applyBps(value, bpsFromPercent(percent))
}

// ---------------------------------------------------------------------------
// Allocation — splitting money without losing or inventing centavos
// ---------------------------------------------------------------------------

/**
 * Split `total` across `weights` so the parts always sum back to exactly
 * `total`. Uses the largest-remainder method; leftover centavos go to the
 * largest fractional remainders first, ties broken by position.
 *
 * Needed wherever an order-level amount has to be attributed to line items —
 * prorating a ₱100 discount across 3 items, or splitting shipping for COGS and
 * true-profit reporting in phase 18.
 */
export function allocate(total: Centavos, weights: readonly number[]): Centavos[] {
  if (weights.length === 0) return []
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('Allocation weights must be non-negative finite numbers')
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight === 0) {
    // Nothing to weight by — fall back to an even split so no money vanishes.
    return splitEvenly(total, weights.length)
  }

  // Scale weights to integers so the arithmetic stays exact.
  const scale = 1_000_000
  const intWeights = weights.map((w) => BigInt(Math.round(w * scale)))
  const intTotalWeight = intWeights.reduce((a, b) => a + b, 0n)
  if (intTotalWeight === 0n) return splitEvenly(total, weights.length)

  const sign = total < 0 ? -1n : 1n
  const magnitude = BigInt(Math.abs(total))

  const parts: bigint[] = []
  const remainders: { index: number; remainder: bigint }[] = []
  let distributed = 0n

  for (let i = 0; i < intWeights.length; i++) {
    const numerator = magnitude * intWeights[i]!
    const share = numerator / intTotalWeight
    parts.push(share)
    remainders.push({ index: i, remainder: numerator % intTotalWeight })
    distributed += share
  }

  let leftover = magnitude - distributed
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )
  for (let i = 0; leftover > 0n; i = (i + 1) % remainders.length) {
    const target = remainders[i]!.index
    parts[target] = (parts[target] ?? 0n) + 1n
    leftover -= 1n
  }

  return parts.map((part) => bigIntToCentavos(part * sign))
}

/** Split evenly into `n` parts that sum to exactly `total`. */
export function splitEvenly(total: Centavos, n: number): Centavos[] {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new MoneyError(`Cannot split into ${n} parts`)
  }
  const sign = total < 0 ? -1 : 1
  const magnitude = Math.abs(total)
  const base = Math.floor(magnitude / n)
  const remainder = magnitude - base * n
  return Array.from({ length: n }, (_, i) =>
    centavos((base + (i < remainder ? 1 : 0)) * sign),
  )
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const isZero = (value: Centavos): boolean => value === 0
export const isPositive = (value: Centavos): boolean => value > 0
export const isNegative = (value: Centavos): boolean => value < 0

export function compare(a: Centavos, b: Centavos): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

export function max(...values: Centavos[]): Centavos {
  if (values.length === 0) throw new MoneyError('max() requires at least one value')
  return centavos(Math.max(...values))
}

export function min(...values: Centavos[]): Centavos {
  if (values.length === 0) throw new MoneyError('min() requires at least one value')
  return centavos(Math.min(...values))
}

export function clamp(value: Centavos, lower: Centavos, upper: Centavos): Centavos {
  if (lower > upper) throw new MoneyError('clamp() lower bound exceeds upper bound')
  return centavos(Math.min(Math.max(value, lower), upper))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Include the ₱ symbol. Default true. */
  symbol?: boolean
  /** Show `.00` on whole amounts. Default true. */
  cents?: boolean
  /** Render negatives as `(₱1,234.56)` instead of `-₱1,234.56`. Default false. */
  accounting?: boolean
}

/** `formatPHP(centavos(123456))` -> `"₱1,234.56"` */
export function formatPHP(value: Centavos, options: FormatOptions = {}): string {
  const { symbol = true, cents = true, accounting = false } = options
  const negative = value < 0
  const magnitude = Math.abs(value)
  const whole = Math.floor(magnitude / 100)
  const fraction = magnitude % 100

  const showCents = cents || fraction !== 0
  const groupedWhole = whole.toLocaleString('en-PH')
  const body = showCents
    ? `${groupedWhole}.${String(fraction).padStart(2, '0')}`
    : groupedWhole
  const withSymbol = symbol ? `₱${body}` : body

  if (!negative) return withSymbol
  return accounting ? `(${withSymbol})` : `-${withSymbol}`
}

/** Bare numeric string for text inputs: `"1234.56"`. No symbol, no grouping. */
export function toPesoInputValue(value: Centavos): string {
  const negative = value < 0
  const magnitude = Math.abs(value)
  const body = `${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`
  return negative ? `-${body}` : body
}

/**
 * Peso amount as a `number`. **Display and charting only** — never feed the
 * result back into arithmetic, that is how float bugs get in.
 */
export function toPesosUnsafe(value: Centavos): number {
  return value / 100
}

/** Format basis points for display: `formatBps(250)` -> `"2.5%"` */
export function formatBps(rate: Bps): string {
  const whole = Math.floor(Math.abs(rate) / 100)
  const fraction = Math.abs(rate) % 100
  const sign = rate < 0 ? '-' : ''
  if (fraction === 0) return `${sign}${whole}%`
  const fractionStr = String(fraction).padStart(2, '0').replace(/0$/, '')
  return `${sign}${whole}.${fractionStr}%`
}

// ---------------------------------------------------------------------------
// Postgres bigint interop
// ---------------------------------------------------------------------------

/**
 * Coerce a value coming out of Postgres into `Centavos`.
 *
 * PostgREST serialises `bigint` as a JSON number, but some drivers return it as
 * a string to preserve precision. Accept both.
 */
export function fromDb(value: number | string | null | undefined): Centavos {
  if (value === null || value === undefined) return ZERO
  if (typeof value === 'number') return centavos(value)
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new MoneyError(`Cannot read "${value}" from the database as centavos`)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) {
    throw new MoneyError(`Database centavos value ${value} exceeds the safe integer range`)
  }
  return parsed as Centavos
}

/** Serialise for Postgres. Always an integer. */
export function toDb(value: Centavos): number {
  return value
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function bigIntToCentavos(value: bigint): Centavos {
  if (value > BigInt(MAX_SAFE_CENTAVOS) || value < -BigInt(MAX_SAFE_CENTAVOS)) {
    throw new MoneyError(`Result ${value} exceeds the safe centavo range`)
  }
  return Number(value) as Centavos
}

/** Divide, rounding the quotient half away from zero. */
function divideRounded(numerator: bigint, denominator: bigint): Centavos {
  if (denominator === 0n) throw new MoneyError('Division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const absNumerator = numerator < 0n ? -numerator : numerator
  const absDenominator = denominator < 0n ? -denominator : denominator

  const quotient = absNumerator / absDenominator
  const remainder = absNumerator % absDenominator
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient

  return bigIntToCentavos(negative ? -rounded : rounded)
}
