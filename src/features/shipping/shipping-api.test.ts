import { describe, expect, it } from 'vitest'

import { centavos } from '@/lib/money'

import {
  byResolutionOrder,
  describeRate,
  describeShippingError,
  zoneSpecificity,
  type ShippingRate,
  type ShippingZone,
} from './shipping-api'

/**
 * The error strings below are not invented — they are the exact `message` values
 * PostgREST returned for each guard, captured by posting the offending row at
 * `/rest/v1/...` with a real authenticated JWT. A hand-written approximation is
 * worthless here: the whole function is a substring match against text this
 * project does not control, so the test is only meaningful if the text is real.
 */
const REAL_MESSAGES = {
  duplicateArea:
    'duplicate key value violates unique constraint "shipping_zone_areas_city_idx"',
  duplicateProvince:
    'duplicate key value violates unique constraint "shipping_zone_areas_province_idx"',
  duplicateRegion:
    'duplicate key value violates unique constraint "shipping_zone_areas_region_idx"',
  secondDefault:
    'duplicate key value violates unique constraint "shipping_zones_one_default_idx"',
  duplicateName:
    'duplicate key value violates unique constraint "shipping_zones_tenant_id_name_key"',
  flatNeedsAmount:
    'new row for relation "shipping_rates" violates check constraint "shipping_rates_flat_needs_amount"',
  unknownPlace:
    'insert or update on table "shipping_zone_areas" violates foreign key constraint "shipping_zone_areas_city_code_fkey"',
  notAllowed: 'permission denied for table shipping_zones',
} as const

/**
 * What supabase-js actually hands back, which is the whole point of this test.
 *
 * On the `const { error } = await client.from(…)` path postgrest-js does
 * `error = JSON.parse(body)` — a **plain object**, not its `PostgrestError` class.
 * That class is only constructed under `.throwOnError()`. Modelling this as
 * `new Error(message)` is what let a broken `instanceof Error` guard ship: the
 * strings matched, the container did not, and every seller-facing message
 * collapsed to "please try again".
 *
 * So: plain object, no prototype games. If someone reintroduces an instanceof
 * guard, these tests go red.
 */
function postgrestError(message: string, code: string): unknown {
  return { message, code, details: null, hint: null }
}

describe('describeShippingError', () => {
  it('names the fix for a place that is already in another zone', () => {
    for (const message of [
      REAL_MESSAGES.duplicateArea,
      REAL_MESSAGES.duplicateProvince,
      REAL_MESSAGES.duplicateRegion,
    ]) {
      expect(describeShippingError(postgrestError(message, '23505'))).toBe('area_taken')
    }
  })

  it('distinguishes a second fallback zone from a duplicate name', () => {
    expect(describeShippingError(postgrestError(REAL_MESSAGES.secondDefault, '23505'))).toBe(
      'one_default',
    )
    expect(describeShippingError(postgrestError(REAL_MESSAGES.duplicateName, '23505'))).toBe(
      'name_taken',
    )
  })

  it('reports a flat rate saved without an amount', () => {
    expect(
      describeShippingError(postgrestError(REAL_MESSAGES.flatNeedsAmount, '23514')),
    ).toBe('flat_needs_amount')
  })

  it('reports a PSGC code that no longer exists', () => {
    expect(describeShippingError(postgrestError(REAL_MESSAGES.unknownPlace, '23503'))).toBe(
      'unknown_place',
    )
  })

  it('reports missing access rather than a retryable failure', () => {
    expect(describeShippingError(postgrestError(REAL_MESSAGES.notAllowed, '42501'))).toBe(
      'not_allowed',
    )
  })

  it('falls back to unknown for anything unrecognised', () => {
    expect(describeShippingError(new Error('the network went away'))).toBe('unknown')
    expect(describeShippingError('a string')).toBe('unknown')
    expect(describeShippingError(null)).toBe('unknown')
  })
})

describe('describeRate', () => {
  const base: ShippingRate = {
    id: 'r1',
    name: 'Standard',
    rateType: 'flat',
    flat: centavos(80_00),
    freeOver: centavos(2000_00),
    isActive: true,
    sortOrder: 0,
    tiers: [],
  }

  it('reports a flat amount with its free-shipping threshold', () => {
    expect(describeRate(base)).toEqual({
      kind: 'flat',
      amount: centavos(80_00),
      freeOver: centavos(2000_00),
      tierCount: 0,
    })
  })

  it('has no single amount for a weight-tiered rate', () => {
    // The flat column doubles as the courier fallback, so a tiered rate can carry
    // a non-null value there. Reporting it as "the" price would tell the seller
    // their tiers are being ignored.
    const tiered: ShippingRate = {
      ...base,
      rateType: 'weight_tiered',
      tiers: [
        { id: 't1', upToGrams: 1000, price: centavos(80_00) },
        { id: 't2', upToGrams: null, price: centavos(150_00) },
      ],
    }
    expect(describeRate(tiered)).toEqual({
      kind: 'weight_tiered',
      amount: null,
      freeOver: centavos(2000_00),
      tierCount: 2,
    })
  })

  it('reports a zone with no rate rather than a free one', () => {
    // "none" and "₱0.00" are different sentences: one is unconfigured, the other
    // is free shipping the seller chose.
    expect(describeRate(undefined)).toEqual({
      kind: 'none',
      amount: null,
      freeOver: null,
      tierCount: 0,
    })
  })
})

describe('resolution order', () => {
  function zone(
    name: string,
    levels: ('city' | 'province' | 'region')[],
    extra: { isDefault?: boolean; sortOrder?: number } = {},
  ): ShippingZone {
    return {
      id: name,
      name,
      isDefault: extra.isDefault ?? false,
      sortOrder: extra.sortOrder ?? 0,
      areas: levels.map((level, index) => ({
        id: `${name}-${index}`,
        level,
        code: `${index}`,
        name: `${level} ${index}`,
      })),
      rates: [],
    }
  }

  it('ranks a zone by the most specific rule it holds', () => {
    expect(zoneSpecificity(zone('City', ['city']))).toBe(3)
    expect(zoneSpecificity(zone('Province', ['province']))).toBe(2)
    expect(zoneSpecificity(zone('Region', ['region']))).toBe(1)
    expect(zoneSpecificity(zone('Fallback', [], { isDefault: true }))).toBe(0)
    // Mixed levels: the zone can win at city level, so that is what it is ranked by.
    expect(zoneSpecificity(zone('Mixed', ['region', 'city']))).toBe(3)
    // A zone with no areas cannot match anything, and must not outrank the fallback.
    expect(zoneSpecificity(zone('Empty', []))).toBe(0)
  })

  /**
   * The ordering the screen promises, with `sortOrder` deliberately pointing the
   * other way.
   *
   * `sortOrder` defaults to 0 for every zone the UI creates, so it carries no
   * specificity information — but it *looks* like a priority, which is what makes
   * "just order by sortOrder" the tempting wrong answer. Giving the catch-all the
   * lowest sortOrder and the city zone the highest means a sortOrder-only
   * implementation produces the exact reverse of this expectation. The same trap
   * caught the SQL fixture in supabase/tests/tenancy-isolation.sql, where a
   * specificity-ordered fixture passed against a resolver with the specificity
   * tiebreak deleted.
   */
  it('puts the most specific zone first and the catch-all last', () => {
    const zones = [
      zone('Rest of PH', [], { isDefault: true, sortOrder: 0 }),
      zone('Mindanao', ['region'], { sortOrder: 5 }),
      zone('Davao City', ['city'], { sortOrder: 9 }),
      zone('Cebu province', ['province'], { sortOrder: 7 }),
    ]

    expect([...zones].sort(byResolutionOrder).map((z) => z.name)).toEqual([
      'Davao City',
      'Cebu province',
      'Mindanao',
      'Rest of PH',
    ])
  })

  it('falls back to sortOrder, then name, between equally specific zones', () => {
    const zones = [
      zone('Zamboanga', ['city'], { sortOrder: 2 }),
      zone('Bacolod', ['city'], { sortOrder: 1 }),
      zone('Aparri', ['city'], { sortOrder: 2 }),
    ]
    expect([...zones].sort(byResolutionOrder).map((z) => z.name)).toEqual([
      'Bacolod',
      'Aparri',
      'Zamboanga',
    ])
  })
})
