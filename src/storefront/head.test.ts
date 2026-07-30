import { describe, expect, it } from 'vitest'

import { buildHead, escapeHtml, serializeForScript } from './head'
import type { HomePayload, PageData, ProductPayload, Store } from './storefront-data'

const ORIGIN = 'https://rheas-finds.selld.ph'
const STORAGE = 'https://xyz.supabase.co'

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 't1',
    name: "Rhea's Finds",
    slug: 'rheas-finds',
    customDomain: null,
    logoPath: null,
    brandColor: '#b0245f',
    locale: 'tl',
    theme: { hero: { headline: 'Authentic skincare', subheadline: 'Legit items, COD available.' } },
    ...overrides,
  }
}

function homeData(
  overrides: Partial<HomePayload> = {},
  // Typed explicitly: inferring from the default narrows both fields to `null`,
  // so passing a real category or search term is a type error.
  query: { category: string | null; search: string | null } = { category: null, search: null },
): PageData {
  return {
    route: 'home',
    payload: { store: store(), products: [], categories: [], productCount: 0, ...overrides },
    query,
  }
}

function productData(overrides: Partial<ProductPayload> = {}): PageData {
  return {
    route: 'product',
    payload: {
      store: store(),
      product: {
        id: 'p1',
        name: 'Linen Blend Blouse',
        slug: 'linen-blend-blouse',
        description: 'Breathable linen blend.',
        categoryName: 'Ready to Wear',
        categorySlug: 'rtw',
        isCodAllowed: true,
        weightGrams: 240,
        createdAt: '2026-07-30T00:00:00Z',
      },
      images: [],
      options: [],
      variants: [
        {
          id: 'v1',
          sku: 'B-S',
          price: 69900,
          compareAt: 89900,
          optionValueIds: [],
          inStock: true,
          stockState: 'ok',
        },
      ],
      related: [],
      ...overrides,
    },
  }
}

describe('escapeHtml()', () => {
  it('neutralises an attribute break-out', () => {
    // Store and product names are seller-authored and go into the head by string
    // concatenation, so this is the only thing standing between a product called
    // `"><script>` and an actual script tag.
    expect(escapeHtml('"><script>alert(1)</script>')).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('escapes ampersands before anything else', () => {
    // Order matters: escaping `<` first and `&` second would turn `<` into
    // `&amp;lt;` and render the literal text "&lt;" to the buyer.
    expect(escapeHtml('Skincare & RTW')).toBe('Skincare &amp; RTW')
    expect(escapeHtml('<a>')).toBe('&lt;a&gt;')
  })
})

describe('serializeForScript()', () => {
  it('cannot terminate the script element it sits in', () => {
    const payload = { note: '</script><script>alert(1)</script>' }
    const out = serializeForScript(payload)
    expect(out).not.toContain('</script')
    expect(out).not.toContain('<')
    // Still valid JSON, and identical after parsing — the escaping is at the
    // JSON-string level, not a mangling of the value.
    expect(JSON.parse(out)).toEqual(payload)
  })

  it('escapes line separators that would break a JS string literal', () => {
    const out = serializeForScript({ a: '  ' })
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    expect(JSON.parse(out)).toEqual({ a: '  ' })
  })
})

describe('buildHead() — canonicals', () => {
  it('canonicalises a search page to the store root', () => {
    // A search URL is an infinite, thin surface. Left canonical to itself, every
    // `?q=` permutation becomes a near-duplicate page competing with the store.
    const head = buildHead({
      data: homeData({}, { category: null, search: 'serum' }),
      origin: ORIGIN,
      storageOrigin: STORAGE,
      path: '/?q=serum',
    })
    expect(head.tags).toContain(`<link rel="canonical" href="${ORIGIN}/" />`)
    expect(head.tags).toContain('name="robots" content="noindex,follow"')
  })

  it('keeps a category page indexable and self-canonical', () => {
    const head = buildHead({
      data: homeData({}, { category: 'bags', search: null }),
      origin: ORIGIN,
      storageOrigin: STORAGE,
      path: '/?category=bags',
    })
    expect(head.tags).toContain(`href="${ORIGIN}/?category=bags"`)
    expect(head.tags).not.toContain('noindex')
  })

  it('never lets a missing store be indexed', () => {
    const head = buildHead({
      data: { route: 'not-found', store: null, hostname: 'typo.selld.ph' },
      origin: ORIGIN,
      storageOrigin: STORAGE,
      path: '/',
    })
    expect(head.tags).toContain('noindex')
    expect(head.jsonLd).toBeNull()
  })
})

describe('buildHead() — product structured data', () => {
  it('emits Offer for a single price and a PHP amount in pesos', () => {
    const head = buildHead({
      data: productData(),
      origin: ORIGIN,
      storageOrigin: STORAGE,
      path: '/p/linen-blend-blouse',
    })
    expect(head.jsonLd).not.toBeNull()
    const parsed = JSON.parse(head.jsonLd!) as Record<string, unknown>
    const offers = parsed.offers as Record<string, unknown>
    expect(offers['@type']).toBe('Offer')
    // Centavos must become pesos here — schema.org price is a currency amount.
    expect(offers.price).toBe('699.00')
    expect(offers.priceCurrency).toBe('PHP')
    expect(offers.availability).toBe('https://schema.org/InStock')
  })

  it('emits AggregateOffer when variants span a range', () => {
    // Offer with lowPrice/highPrice is invalid structured data and Google drops
    // the entire block rather than the extra field.
    const data = productData({
      variants: [
        { id: 'a', sku: null, price: 69900, compareAt: null, optionValueIds: [], inStock: true, stockState: 'ok' },
        { id: 'b', sku: null, price: 99900, compareAt: null, optionValueIds: [], inStock: false, stockState: 'out' },
      ],
    })
    const head = buildHead({ data, origin: ORIGIN, storageOrigin: STORAGE, path: '/p/x' })
    const offers = (JSON.parse(head.jsonLd!) as Record<string, unknown>).offers as Record<
      string,
      unknown
    >
    expect(offers['@type']).toBe('AggregateOffer')
    expect(offers.lowPrice).toBe('699.00')
    expect(offers.highPrice).toBe('999.00')
  })

  it('reports out of stock when no variant is buyable', () => {
    const data = productData({
      variants: [
        { id: 'a', sku: null, price: 69900, compareAt: null, optionValueIds: [], inStock: false, stockState: 'out' },
      ],
    })
    const head = buildHead({ data, origin: ORIGIN, storageOrigin: STORAGE, path: '/p/x' })
    expect(head.tags).toContain('content="out of stock"')
    const offers = (JSON.parse(head.jsonLd!) as Record<string, unknown>).offers as Record<
      string,
      unknown
    >
    expect(offers.availability).toBe('https://schema.org/OutOfStock')
  })

  it('declares no og:image dimensions when the size is unknown', () => {
    // The real photo's dimensions are not stored, and a wrong width/height makes
    // Facebook crop to the hint instead of measuring the file.
    const data = productData({
      images: [{ id: 'i1', variantId: null, path: 'p/a.png', alt: null, renditions: [] }],
    })
    const head = buildHead({ data, origin: ORIGIN, storageOrigin: STORAGE, path: '/p/x' })
    expect(head.tags).toContain('property="og:image"')
    expect(head.tags).not.toContain('og:image:width')
  })

  it('falls back to the store logo for a product with no photo', () => {
    const data = productData({ store: store({ logoPath: 'logo.png' }) })
    const head = buildHead({ data, origin: ORIGIN, storageOrigin: STORAGE, path: '/p/x' })
    expect(head.tags).toContain(`${STORAGE}/storage/v1/object/public/tenant-public/logo.png`)
  })

  it('uses tl_PH for a Taglish store, because Facebook wants a full locale', () => {
    const head = buildHead({
      data: productData(),
      origin: ORIGIN,
      storageOrigin: STORAGE,
      path: '/p/x',
    })
    expect(head.tags).toContain('property="og:locale" content="tl_PH"')
  })
})
