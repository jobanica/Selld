import { describe, expect, it } from 'vitest'

import {
  isDeliverable,
  money,
  nextAddressLevel,
  type CheckoutAddress,
  type PsgcOptions,
} from './cart-data'

function options(overrides: Partial<PsgcOptions> = {}): PsgcOptions {
  return { regions: [], provinces: [], cities: [], barangays: [], ...overrides }
}

const unit = (code: string) => ({ code, name: code })

describe('isDeliverable()', () => {
  it('needs region, city and barangay', () => {
    expect(
      isDeliverable({ regionCode: '13', cityCode: '1339', barangayCode: '133901001' }),
    ).toBe(true)
  })

  it('does NOT require a province', () => {
    // NCR has no provinces at all, and three independent cities have none either.
    // Requiring one makes checkout impossible for every buyer in Metro Manila.
    const ncr: Partial<CheckoutAddress> = {
      regionCode: '130000000',
      provinceCode: null,
      cityCode: '133900000',
      barangayCode: '133901001',
    }
    expect(isDeliverable(ncr)).toBe(true)
  })

  it('does not require a street', () => {
    // Plenty of PH addresses are a barangay plus a landmark. Demanding a house
    // number rejects addresses that couriers deliver to every day.
    expect(isDeliverable({ regionCode: '1', cityCode: '2', barangayCode: '3' })).toBe(true)
  })

  it('rejects a missing barangay', () => {
    // Barangay is the unit couriers route on.
    expect(isDeliverable({ regionCode: '1', cityCode: '2', barangayCode: '' })).toBe(false)
    expect(isDeliverable({ regionCode: '1', cityCode: '2' })).toBe(false)
  })

  it('rejects an empty address', () => {
    expect(isDeliverable({})).toBe(false)
  })
})

describe('nextAddressLevel()', () => {
  it('asks for a region first', () => {
    expect(nextAddressLevel({}, options())).toBe('region')
  })

  it('asks for a province when the region has them', () => {
    expect(
      nextAddressLevel({ regionCode: '010000000' }, options({ provinces: [unit('012800000')] })),
    ).toBe('province')
  })

  it('skips straight to city when the region has no provinces', () => {
    // The NCR case. An empty province list means "not applicable", not "unanswered"
    // — treating it as unanswered strands every Metro Manila buyer on a step with
    // no options to pick from.
    expect(nextAddressLevel({ regionCode: '130000000' }, options({ provinces: [] }))).toBe('city')
  })

  it('asks for a city once a province is chosen', () => {
    expect(
      nextAddressLevel(
        { regionCode: '010000000', provinceCode: '012800000' },
        options({ provinces: [unit('012800000')] }),
      ),
    ).toBe('city')
  })

  it('asks for a barangay once a city is chosen', () => {
    expect(
      nextAddressLevel({ regionCode: '13', cityCode: '1339' }, options({ cities: [unit('1339')] })),
    ).toBe('barangay')
  })

  it('returns null when nothing more is needed', () => {
    expect(
      nextAddressLevel({ regionCode: '13', cityCode: '1339', barangayCode: '133901001' }, options()),
    ).toBeNull()
  })

  it('agrees with isDeliverable — null level implies deliverable', () => {
    // These two drive different things (the cascade button and the submit), so a
    // disagreement would show up as a buyer who can never finish or a form that
    // submits incomplete.
    const cases: Partial<CheckoutAddress>[] = [
      {},
      { regionCode: '13' },
      { regionCode: '13', cityCode: '1339' },
      { regionCode: '13', cityCode: '1339', barangayCode: '133901001' },
    ]
    for (const address of cases) {
      const level = nextAddressLevel(address, options())
      expect(level === null, JSON.stringify(address)).toBe(isDeliverable(address))
    }
  })
})

describe('money()', () => {
  it('brands a centavo amount', () => {
    expect(money(37800)).toBe(37800)
  })

  it('treats a missing amount as zero rather than NaN', () => {
    // A total of NaN renders as "₱NaN" on a buyer's checkout page.
    expect(money(null)).toBe(0)
    expect(money(undefined)).toBe(0)
  })

  it('keeps zero as zero', () => {
    expect(money(0)).toBe(0)
  })
})
