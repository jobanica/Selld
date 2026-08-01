import { formatPHP } from '@/lib/money'

import type { CartPageData } from './cart-data'
import { price, priceRange, storageUrl, type PageData, type Store } from './storefront-data'

type AnyPage = PageData | CartPageData

/**
 * The document head, as a string.
 *
 * Built by string concatenation rather than with a head-management library
 * (react-helmet and friends) because the server already owns the HTML shell and
 * the head never changes after the first paint — there is no client router. A
 * library here would add bytes to a buyer's bundle to solve a problem this
 * surface does not have.
 */

/**
 * Escape for use inside an HTML attribute or text node.
 *
 * Every value below is seller-authored (store name, product name, description),
 * so this is the boundary that keeps a product called `"><script>` from becoming
 * one. React escapes the body for us; the head is hand-built, so it is on us.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Serialize a payload for inlining in a `<script type="application/json">`.
 *
 * `JSON.stringify` alone is not enough: a literal `</script>` inside any string
 * value ends the element early and everything after it is parsed as HTML. `<!--`
 * can do the same in the legacy comment parsing path. Escaping the `<` as a
 * unicode sequence keeps the JSON valid and identical after parsing.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // Written as escapes, not literal characters: U+2028/U+2029 are invisible in
    // an editor, are line terminators inside a JS string literal, and trip
    // no-irregular-whitespace.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

export interface HeadInput {
  data: AnyPage
  origin: string
  storageOrigin: string
  /** Path with query, for the canonical URL. */
  path: string
}

export interface HeadResult {
  title: string
  tags: string
  jsonLd: string | null
}

export function buildHead({ data, origin, storageOrigin, path }: HeadInput): HeadResult {
  // Cart, checkout and the receipt are per-buyer pages with nothing to rank and,
  // from the checkout step onward, a name, phone number and address on them. They
  // are noindex, carry no canonical, and get no OG tags — a crawler that indexed a
  // receipt would publish somebody's address.
  //
  // The tracking page is in this list too, and for the same reason rather than a
  // weaker one: it carries a buyer's first name and destination city, and its URL
  // contains an order number. A crawler that indexed it would make every order
  // number in a store enumerable from a search engine.
  if (
    data.route === 'cart' ||
    data.route === 'checkout' ||
    data.route === 'order-confirmed' ||
    data.route === 'track'
  ) {
    const name = data.store?.name ?? 'Selld'
    const title =
      data.route === 'cart'
        ? `Cart · ${name}`
        : data.route === 'checkout'
          ? `Checkout · ${name}`
          : data.route === 'track'
            ? `Track ${data.tracking?.orderNumber ?? 'order'} · ${name}`
            : `Order ${data.receipt.orderNumber} · ${name}`
    return {
      title,
      tags: '<meta name="robots" content="noindex,nofollow" />',
      jsonLd: null,
    }
  }

  /**
   * The privacy notice is the one page in this group that *should* be indexed.
   * A notice that search cannot find is a notice a buyer cannot check before
   * they buy, which is the moment it exists for.
   */
  if (data.route === 'privacy') {
    return {
      title: `Privacy · ${data.store?.name ?? 'Selld'}`,
      tags: '',
      jsonLd: null,
    }
  }

  if (data.route === 'not-found') {
    return {
      title: 'Store not found · Selld',
      // A missing store must never be indexed — otherwise a typo'd subdomain
      // ends up in search results as if it were a real shop.
      tags: '<meta name="robots" content="noindex,follow" />',
      jsonLd: null,
    }
  }

  const store = data.payload.store
  const canonical = `${origin}${canonicalPath(data, path)}`

  if (data.route === 'product' && data.payload.product !== null) {
    const { product, images, variants } = data.payload
    const prices = variants.map((variant) => variant.price)
    const from = price(prices.length === 0 ? null : Math.min(...prices))
    const inStock = variants.some((variant) => variant.inStock)

    const title = `${product.name} · ${store.name}`
    const description = truncate(
      product.description !== null && product.description.trim() !== ''
        ? product.description
        : `${product.name} — available from ${store.name}${from === null ? '' : ` for ${formatPHP(from)}`}.`,
      160,
    )
    // Real photo first; the store's logo when the product has none. A photo-less
    // product is a normal mid-setup state, and a bare grey box in a Messenger
    // thread costs the seller the click.
    const image = ogImageUrl({
      store,
      storageOrigin,
      origin,
      imagePath: images[0]?.path ?? store.logoPath,
    })

    return {
      title,
      tags: [
        meta('description', description),
        link('canonical', canonical),
        ...openGraph({
          type: 'product',
          title: `${product.name} — ${from === null ? '' : formatPHP(from)}`.trim(),
          description,
          url: canonical,
          image,
          imageSize: null,
          siteName: store.name,
          locale: store.locale,
        }),
        // Price and availability as OG product properties: Facebook renders them
        // in the link preview, which is where most of this store's traffic comes
        // from.
        from === null ? '' : meta('product:price:amount', (from / 100).toFixed(2), 'property'),
        from === null ? '' : meta('product:price:currency', 'PHP', 'property'),
        meta('product:availability', inStock ? 'in stock' : 'out of stock', 'property'),
      ]
        .filter((tag) => tag !== '')
        .join(''),
      jsonLd: productJsonLd({ data, store, canonical, image }),
    }
  }

  // Home, optionally filtered.
  const filtered = data.route === 'home' && (data.query.category !== null || data.query.search !== null)
  const hero = store.theme.hero ?? {}
  const title = filtered
    ? `${data.query.search ?? data.query.category} · ${store.name}`
    : `${store.name} — ${truncate(hero.headline ?? 'Online store', 60)}`
  const description = truncate(
    hero.subheadline ?? hero.headline ?? `Shop ${store.name}. Cash on delivery available.`,
    160,
  )
  // Hero image, then the logo, then the newest product's photo. A store with no
  // hero art is the common case for a new seller, and falling straight through to
  // "no og:image" means their store link posts to Messenger as a bare grey box —
  // which is the single place this store's traffic comes from.
  const homeImagePath =
    hero.imagePath ??
    store.logoPath ??
    (data.route === 'home' ? (data.payload.products.find((p) => p.image !== null)?.image ?? null) : null)
  const image = ogImageUrl({ store, storageOrigin, origin, imagePath: homeImagePath })

  return {
    title,
    tags: [
      meta('description', description),
      link('canonical', canonical),
      // A search-results URL is a thin, infinite surface. Indexing it competes
      // with the store's own pages for crawl budget and ranks nothing.
      data.route === 'home' && data.query.search !== null
        ? meta('robots', 'noindex,follow')
        : '',
      ...openGraph({
        type: 'website',
        title,
        description,
        url: canonical,
        image,
        imageSize: null,
        siteName: store.name,
        locale: store.locale,
      }),
    ]
      .filter((tag) => tag !== '')
      .join(''),
    jsonLd: storeJsonLd({ store, canonical }),
  }
}

/**
 * Canonical path.
 *
 * A category filter is a real, indexable page. A search query is not — it
 * canonicalises to the unfiltered store so a thousand `?q=` permutations do not
 * become a thousand near-duplicate URLs competing with each other.
 */
function canonicalPath(data: AnyPage, path: string): string {
  if (data.route === 'product' && data.payload.product !== null) {
    return `/p/${data.payload.product.slug}`
  }
  if (data.route === 'home') {
    if (data.query.search !== null) return '/'
    if (data.query.category !== null) return `/?category=${encodeURIComponent(data.query.category)}`
    return '/'
  }
  return path
}

function meta(name: string, content: string, attribute: 'name' | 'property' = 'name'): string {
  return `<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}" />`
}

function link(rel: string, href: string): string {
  return `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}" />`
}

function openGraph(input: {
  type: string
  title: string
  description: string
  url: string
  image: string | null
  imageSize: { width: number; height: number } | null
  siteName: string
  locale: string
}): string[] {
  return [
    meta('og:type', input.type, 'property'),
    meta('og:title', input.title, 'property'),
    meta('og:description', input.description, 'property'),
    meta('og:url', input.url, 'property'),
    meta('og:site_name', input.siteName, 'property'),
    // Facebook wants a full locale, and PH sellers' buyers are on FB above all.
    meta('og:locale', input.locale === 'tl' ? 'tl_PH' : 'en_PH', 'property'),
    input.image === null ? '' : meta('og:image', input.image, 'property'),
    // Dimensions only when they are actually known. `product_images` stores no
    // width/height, so for a seller's own photo we do not know them — and
    // declaring 1200x630 over a square photo is worse than saying nothing, because
    // Facebook crops to the hint it was given instead of measuring the file.
    input.image === null || input.imageSize === null
      ? ''
      : meta('og:image:width', String(input.imageSize.width), 'property'),
    input.image === null || input.imageSize === null
      ? ''
      : meta('og:image:height', String(input.imageSize.height), 'property'),
    meta('twitter:card', input.image === null ? 'summary' : 'summary_large_image'),
    meta('twitter:title', input.title),
    meta('twitter:description', input.description),
  ].filter((tag) => tag !== '')
}

/**
 * Which image a link preview should use.
 *
 * The seller's real photo wins whenever there is one. A generated branded card
 * is prettier in a portfolio but performs worse in a Messenger thread — buyers
 * tap product photos. The generated card at `/og/...` is the fallback for
 * products with no photo yet, which is a real state for a store mid-setup.
 */
export function ogImageUrl(input: {
  store: Store
  storageOrigin: string
  origin: string
  imagePath: string | null
}): string | null {
  const real = storageUrl(input.storageOrigin, input.imagePath)
  if (real !== null) return real
  return null
}

function storeJsonLd({ store, canonical }: { store: Store; canonical: string }): string {
  return serializeForScript({
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: store.name,
    url: canonical,
    ...(store.theme.hero?.subheadline === undefined
      ? {}
      : { description: store.theme.hero.subheadline }),
  })
}

function productJsonLd({
  data,
  store,
  canonical,
  image,
}: {
  data: AnyPage
  store: Store
  canonical: string
  image: string | null
}): string | null {
  if (data.route !== 'product' || data.payload.product === null) return null
  const { product, variants } = data.payload
  const { from, to, isRange } = priceRange({
    priceFrom: variants.length === 0 ? null : Math.min(...variants.map((v) => v.price)),
    priceTo: variants.length === 0 ? null : Math.max(...variants.map((v) => v.price)),
  })
  if (from === null) return null

  const availability = variants.some((variant) => variant.inStock)
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock'

  // A range needs AggregateOffer; a single price needs Offer. Emitting Offer with
  // a lowPrice/highPrice pair is invalid structured data and Google drops the
  // whole block rather than the extra field.
  const offers =
    isRange && to !== null
      ? {
          '@type': 'AggregateOffer',
          priceCurrency: 'PHP',
          lowPrice: (from / 100).toFixed(2),
          highPrice: (to / 100).toFixed(2),
          offerCount: variants.length,
          availability,
        }
      : {
          '@type': 'Offer',
          priceCurrency: 'PHP',
          price: (from / 100).toFixed(2),
          availability,
          url: canonical,
        }

  return serializeForScript({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description === null ? {} : { description: truncate(product.description, 500) }),
    ...(image === null ? {} : { image: [image] }),
    ...(variants[0]?.sku === null || variants[0]?.sku === undefined
      ? {}
      : { sku: variants[0].sku }),
    brand: { '@type': 'Brand', name: store.name },
    offers,
  })
}
