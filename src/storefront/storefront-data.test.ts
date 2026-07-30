import { describe, expect, it } from 'vitest'

import {
  isOptionValueAvailable,
  matchVariant,
  priceRange,
  renditionPath,
  srcSet,
  storageUrl,
  type ProductVariant,
} from './storefront-data'

function variant(
  id: string,
  optionValueIds: string[],
  inStock = true,
  price = 10000,
): ProductVariant {
  return {
    id,
    sku: null,
    price,
    compareAt: null,
    optionValueIds,
    inStock,
    stockState: inStock ? 'ok' : 'out',
  }
}

describe('matchVariant()', () => {
  it('auto-selects the only variant of an option-less product', () => {
    const variants = [variant('v1', [])]
    expect(matchVariant(variants, {})?.id).toBe('v1')
  })

  it('does not guess when there is more than one variant and nothing chosen', () => {
    const variants = [variant('v1', ['small']), variant('v2', ['large'])]
    // Guessing here would show a price for a size the buyer never picked, and
    // "add to cart" would add the wrong one.
    expect(matchVariant(variants, {})).toBeNull()
  })

  it('matches regardless of which option the buyer tapped first', () => {
    // `option_value_ids` is stored in option order. The picker's selection map
    // has no order at all, so comparing positionally would work for one tap
    // sequence and fail for the other.
    const variants = [
      variant('v1', ['red', 'small']),
      variant('v2', ['red', 'large']),
      variant('v3', ['blue', 'small']),
    ]
    expect(matchVariant(variants, { colour: 'red', size: 'large' })?.id).toBe('v2')
    expect(matchVariant(variants, { size: 'large', colour: 'red' })?.id).toBe('v2')
  })

  it('returns null for a combination that does not exist', () => {
    const variants = [variant('v1', ['red', 'small'])]
    expect(matchVariant(variants, { colour: 'blue', size: 'small' })).toBeNull()
  })

  it('ignores options that have not been chosen yet', () => {
    const variants = [variant('v1', ['red', 'small'])]
    // One of two options chosen: no unique variant, so no match.
    expect(matchVariant(variants, { colour: 'red', size: '' })).toBeNull()
  })
})

describe('isOptionValueAvailable()', () => {
  const variants = [
    variant('rs', ['red', 'small']),
    variant('rl', ['red', 'large'], false), // red/large sold out
    variant('bl', ['blue', 'large']),
  ]

  it('is available when some in-stock variant uses it', () => {
    expect(isOptionValueAvailable(variants, 'small', {}, 'size')).toBe(true)
  })

  it('respects the rest of the selection', () => {
    // Large exists and is buyable — but not in red, which the buyer already chose.
    // Answering from the whole catalog would enable a combination that is gone.
    expect(isOptionValueAvailable(variants, 'large', { colour: 'red' }, 'size')).toBe(false)
    expect(isOptionValueAvailable(variants, 'large', { colour: 'blue' }, 'size')).toBe(true)
  })

  it('ignores the option being asked about, not just the value', () => {
    // Asking "is red available" while red is selected must not constrain the
    // answer by red itself, or every selected value would validate itself.
    expect(isOptionValueAvailable(variants, 'red', { colour: 'red' }, 'colour')).toBe(true)
  })

  it('is false when every variant using it is sold out', () => {
    const soldOut = [variant('a', ['tiny'], false)]
    expect(isOptionValueAvailable(soldOut, 'tiny', {}, 'size')).toBe(false)
  })
})

describe('priceRange()', () => {
  it('reports a range only when the ends differ', () => {
    expect(priceRange({ priceFrom: 10000, priceTo: 10000 }).isRange).toBe(false)
    expect(priceRange({ priceFrom: 10000, priceTo: 25000 }).isRange).toBe(true)
  })

  it('survives a product with no variants', () => {
    const result = priceRange({ priceFrom: null, priceTo: null })
    expect(result.from).toBeNull()
    expect(result.isRange).toBe(false)
  })

  it('treats zero as a real price, not as missing', () => {
    // A free item is legitimate (a giveaway listing). Falsy-checking the amount
    // would render "Ask for price" over a deliberate ₱0.
    const result = priceRange({ priceFrom: 0, priceTo: 0 })
    expect(result.from).toBe(0)
  })
})

describe('storageUrl()', () => {
  it('builds a public bucket URL', () => {
    expect(storageUrl('https://x.supabase.co', 'abc/logo.png')).toBe(
      'https://x.supabase.co/storage/v1/object/public/tenant-public/abc/logo.png',
    )
  })

  it('tolerates a trailing slash on the origin and a leading one on the path', () => {
    expect(storageUrl('https://x.supabase.co/', '/abc/logo.png')).toBe(
      'https://x.supabase.co/storage/v1/object/public/tenant-public/abc/logo.png',
    )
  })

  it('passes an absolute URL through untouched', () => {
    expect(storageUrl('https://x.supabase.co', 'https://cdn.example/a.jpg')).toBe(
      'https://cdn.example/a.jpg',
    )
  })

  it('returns null for nothing', () => {
    expect(storageUrl('https://x.supabase.co', null)).toBeNull()
    expect(storageUrl('https://x.supabase.co', '   ')).toBeNull()
  })
})

describe('renditionPath()', () => {
  it('inserts the width before the extension so the file keeps its type', () => {
    expect(renditionPath('t/products/soap.png', 400)).toBe('t/products/soap@400.png')
  })

  it('appends when there is no extension', () => {
    expect(renditionPath('t/products/soap', 400)).toBe('t/products/soap@400')
  })

  it('only splits on the last dot', () => {
    expect(renditionPath('t/my.product/soap.png', 700)).toBe('t/my.product/soap@700.png')
  })
})

describe('srcSet()', () => {
  it('lists every known rendition plus the original', () => {
    const set = srcSet('https://x.co', 'p/a.png', [400, 700], 900)
    expect(set).toBe(
      'https://x.co/storage/v1/object/public/tenant-public/p/a@400.png 400w, ' +
        'https://x.co/storage/v1/object/public/tenant-public/p/a@700.png 700w, ' +
        'https://x.co/storage/v1/object/public/tenant-public/p/a.png 900w',
    )
  })

  it('returns null when there are no renditions', () => {
    // Never guess at a rendition URL. A 404 inside srcset is a broken image —
    // the browser does not fall back to another candidate — so an image with no
    // recorded renditions must render with a plain src instead.
    expect(srcSet('https://x.co', 'p/a.png', [], 900)).toBeNull()
  })

  it('returns null for a missing path', () => {
    expect(srcSet('https://x.co', null, [400], 900)).toBeNull()
  })

  it('deduplicates a rendition that equals the natural width', () => {
    const set = srcSet('https://x.co', 'p/a.png', [900], 900)
    // One candidate is not a choice, so there is nothing for srcset to do.
    expect(set).toBeNull()
  })

  it('sorts ascending regardless of input order', () => {
    const set = srcSet('https://x.co', 'p/a.png', [700, 400], 900)
    expect(set?.indexOf('400w')).toBeLessThan(set?.indexOf('700w') ?? -1)
  })
})
