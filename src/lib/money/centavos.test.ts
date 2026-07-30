import { describe, expect, it } from 'vitest'

import {
  add,
  allocate,
  applyBps,
  applyPercent,
  bps,
  bpsFromPercent,
  centavos,
  clamp,
  formatBps,
  formatPHP,
  fromDb,
  MoneyError,
  multiplyByQty,
  negate,
  parsePesos,
  pesos,
  splitEvenly,
  subtract,
  sum,
  toPesoInputValue,
  ZERO,
} from './centavos'

describe('centavos()', () => {
  it('accepts whole numbers', () => {
    expect(centavos(0)).toBe(0)
    expect(centavos(-500)).toBe(-500)
    expect(centavos(123456)).toBe(123456)
  })

  it('rejects fractional centavos — there is no such thing', () => {
    expect(() => centavos(10.5)).toThrow(MoneyError)
    expect(() => centavos(0.1 + 0.2)).toThrow(MoneyError)
  })

  it('rejects non-finite and unsafe values', () => {
    expect(() => centavos(NaN)).toThrow(MoneyError)
    expect(() => centavos(Infinity)).toThrow(MoneyError)
    expect(() => centavos(2 ** 53)).toThrow(MoneyError)
  })
})

describe('parsePesos()', () => {
  it('parses what a seller actually types', () => {
    expect(parsePesos('1234.56')).toBe(123456)
    expect(parsePesos('1,234.56')).toBe(123456)
    expect(parsePesos('₱1,234.56')).toBe(123456)
    expect(parsePesos(' 1234 ')).toBe(123400)
    expect(parsePesos('1234.5')).toBe(123450)
    expect(parsePesos('.5')).toBe(50)
    expect(parsePesos('0')).toBe(0)
    expect(parsePesos('-50.25')).toBe(-5025)
  })

  it('avoids binary float error on numeric input', () => {
    expect(parsePesos(19.99)).toBe(1999)
    expect(parsePesos(0.1 + 0.2)).toBe(30)
    expect(parsePesos(1499)).toBe(149900)
    expect(parsePesos(2899)).toBe(289900)
  })

  it('rejects more than two decimals instead of silently rounding', () => {
    expect(parsePesos('199.999')).toBeNull()
    expect(parsePesos(19.999)).toBeNull()
  })

  it('rejects garbage', () => {
    expect(parsePesos('')).toBeNull()
    expect(parsePesos('   ')).toBeNull()
    expect(parsePesos('abc')).toBeNull()
    expect(parsePesos('-')).toBeNull()
    expect(parsePesos('1.2.3')).toBeNull()
    expect(parsePesos('1e5')).toBeNull()
    expect(parsePesos(NaN)).toBeNull()
    expect(parsePesos(Infinity)).toBeNull()
  })

  it('normalises negative zero', () => {
    expect(parsePesos('-0')).toBe(0)
    expect(Object.is(parsePesos('-0'), -0)).toBe(false)
  })

  it('pesos() throws where parsePesos() returns null', () => {
    expect(() => pesos('nope')).toThrow(MoneyError)
    expect(pesos('1499')).toBe(149900)
  })
})

describe('arithmetic', () => {
  it('adds, subtracts, sums and negates exactly', () => {
    expect(add(pesos('19.99'), pesos('0.01'))).toBe(2000)
    expect(subtract(pesos('100'), pesos('99.99'))).toBe(1)
    expect(sum([pesos('19.99'), pesos('19.99'), pesos('19.99')])).toBe(5997)
    expect(sum([])).toBe(0)
    expect(negate(pesos('10'))).toBe(-1000)
    expect(negate(ZERO)).toBe(0)
  })

  it('multiplies by quantity without drift', () => {
    // The classic float failure: 0.07 * 3 !== 0.21 in binary floating point.
    expect(multiplyByQty(pesos('0.07'), 3)).toBe(21)
    expect(multiplyByQty(pesos('1234.56'), 100)).toBe(12345600)
    expect(multiplyByQty(pesos('99.99'), 0)).toBe(0)
  })

  it('rejects fractional quantities', () => {
    expect(() => multiplyByQty(pesos('10'), 1.5)).toThrow(MoneyError)
  })
})

describe('applyBps() — COD fees, payment fees, percent discounts', () => {
  it('applies a rate', () => {
    expect(applyBps(pesos('1000'), bps(250))).toBe(2500) // 2.5% of ₱1,000 = ₱25
    expect(applyPercent(pesos('300000'), 8)).toBe(2400000) // 8% of ₱300k = ₱24k
  })

  it('rounds half away from zero', () => {
    // ₱0.01 at 50% is exactly half a centavo -> rounds up to 1.
    expect(applyBps(centavos(1), bps(5000))).toBe(1)
    // Same magnitude negative rounds to -1, keeping refunds symmetric.
    expect(applyBps(centavos(-1), bps(5000))).toBe(-1)
    expect(applyBps(centavos(3), bps(5000))).toBe(2) // 1.5 -> 2
    expect(applyBps(centavos(-3), bps(5000))).toBe(-2)
  })

  it('treats 0 and 100% as identities', () => {
    expect(applyBps(pesos('123.45'), bps(0))).toBe(0)
    expect(applyBps(pesos('123.45'), bps(10_000))).toBe(12345)
  })

  it('converts percentages without float error', () => {
    expect(bpsFromPercent(2.5)).toBe(250)
    expect(bpsFromPercent('0.07')).toBe(7)
    expect(bpsFromPercent(8)).toBe(800)
    expect(bpsFromPercent('3.5')).toBe(350)
  })
})

describe('allocate() — money must never be lost or invented', () => {
  it('splits proportionally and sums back exactly', () => {
    const parts = allocate(pesos('100'), [1, 1, 1])
    expect(parts).toEqual([3334, 3333, 3333])
    expect(sum(parts)).toBe(10000)
  })

  it('handles weights that do not divide evenly', () => {
    const parts = allocate(pesos('10'), [1, 2, 3])
    expect(sum(parts)).toBe(1000)
    expect(parts).toEqual([167, 333, 500])
  })

  it('prorates a discount across real line items', () => {
    // ₱100 off an order of ₱299.99 + ₱150.50 + ₱49.51
    const lineTotals = [29999, 15050, 4951]
    const parts = allocate(pesos('100'), lineTotals)
    expect(sum(parts)).toBe(10000)
    // Largest line takes the largest share.
    expect(parts[0]!).toBeGreaterThan(parts[1]!)
    expect(parts[1]!).toBeGreaterThan(parts[2]!)
  })

  it('preserves the total for negative amounts (refunds)', () => {
    const parts = allocate(centavos(-10000), [1, 1, 1])
    expect(sum(parts)).toBe(-10000)
  })

  it('falls back to an even split when all weights are zero', () => {
    expect(sum(allocate(pesos('10'), [0, 0, 0]))).toBe(1000)
  })

  it('returns an empty array for no weights', () => {
    expect(allocate(pesos('10'), [])).toEqual([])
  })

  it('rejects negative weights', () => {
    expect(() => allocate(pesos('10'), [1, -1])).toThrow(MoneyError)
  })

  it('never loses a centavo across many random splits', () => {
    for (let n = 1; n <= 25; n++) {
      const total = centavos(((n * 7919) % 100_000) - 50_000)
      const weights = Array.from({ length: n }, (_, i) => ((i * 31 + 7) % 17) + 1)
      expect(sum(allocate(total, weights))).toBe(total)
    }
  })
})

describe('splitEvenly()', () => {
  it('distributes the remainder to the earliest parts', () => {
    expect(splitEvenly(centavos(10), 3)).toEqual([4, 3, 3])
    expect(sum(splitEvenly(centavos(10), 3))).toBe(10)
    expect(splitEvenly(centavos(-10), 3)).toEqual([-4, -3, -3])
  })

  it('rejects non-positive part counts', () => {
    expect(() => splitEvenly(centavos(10), 0)).toThrow(MoneyError)
    expect(() => splitEvenly(centavos(10), -1)).toThrow(MoneyError)
  })
})

describe('formatPHP()', () => {
  it('formats the way a Filipino seller reads it', () => {
    expect(formatPHP(centavos(123456))).toBe('₱1,234.56')
    expect(formatPHP(centavos(149900))).toBe('₱1,499.00')
    expect(formatPHP(centavos(0))).toBe('₱0.00')
    expect(formatPHP(centavos(25321200))).toBe('₱253,212.00')
  })

  it('honours formatting options', () => {
    expect(formatPHP(centavos(149900), { cents: false })).toBe('₱1,499')
    // cents: false still shows them when they are non-zero, so nothing is hidden.
    expect(formatPHP(centavos(149950), { cents: false })).toBe('₱1,499.50')
    expect(formatPHP(centavos(123456), { symbol: false })).toBe('1,234.56')
    expect(formatPHP(centavos(-123456))).toBe('-₱1,234.56')
    expect(formatPHP(centavos(-123456), { accounting: true })).toBe('(₱1,234.56)')
  })

  it('renders bare values for text inputs', () => {
    expect(toPesoInputValue(pesos('0'))).toBe('0.00')
    expect(toPesoInputValue(pesos('0.05'))).toBe('0.05')
    expect(toPesoInputValue(pesos('1499'))).toBe('1499.00')
    expect(toPesoInputValue(pesos('1234.56'))).toBe('1234.56')
    expect(toPesoInputValue(pesos('-50.25'))).toBe('-50.25')
  })

  it('round-trips input value -> centavos -> input value', () => {
    for (const value of ['0', '0.05', '1499', '1234.56', '-50.25', '999999.99']) {
      const parsed = pesos(value)
      expect(pesos(toPesoInputValue(parsed))).toBe(parsed)
    }
  })
})

describe('formatBps()', () => {
  it('renders rates', () => {
    expect(formatBps(bps(250))).toBe('2.5%')
    expect(formatBps(bps(300))).toBe('3%')
    expect(formatBps(bps(275))).toBe('2.75%')
    expect(formatBps(bps(205))).toBe('2.05%')
    expect(formatBps(bps(0))).toBe('0%')
  })
})

describe('clamp()', () => {
  it('bounds a value', () => {
    expect(clamp(centavos(5), centavos(0), centavos(10))).toBe(5)
    expect(clamp(centavos(-5), centavos(0), centavos(10))).toBe(0)
    expect(clamp(centavos(50), centavos(0), centavos(10))).toBe(10)
  })

  it('rejects an inverted range', () => {
    expect(() => clamp(centavos(5), centavos(10), centavos(0))).toThrow(MoneyError)
  })
})

describe('fromDb()', () => {
  it('reads both number and string bigint representations', () => {
    expect(fromDb(123456)).toBe(123456)
    expect(fromDb('123456')).toBe(123456)
    expect(fromDb('-500')).toBe(-500)
    expect(fromDb(null)).toBe(0)
    expect(fromDb(undefined)).toBe(0)
  })

  it('rejects values it cannot represent exactly', () => {
    expect(() => fromDb('9223372036854775807')).toThrow(MoneyError)
    expect(() => fromDb('12.34')).toThrow(MoneyError)
    expect(() => fromDb('abc')).toThrow(MoneyError)
  })
})

describe('the commission math from the offer doc', () => {
  it('reproduces the closing slide exactly', () => {
    const monthlySales = pesos('300000')
    const monthlyCommission = applyPercent(monthlySales, 8)
    const annualCommission = multiplyByQty(monthlyCommission, 12)
    const annualSelld = multiplyByQty(pesos('2899'), 12)
    const kept = subtract(annualCommission, annualSelld)

    expect(formatPHP(annualCommission, { cents: false })).toBe('₱288,000')
    expect(formatPHP(annualSelld, { cents: false })).toBe('₱34,788')
    expect(formatPHP(kept, { cents: false })).toBe('₱253,212')
  })
})
