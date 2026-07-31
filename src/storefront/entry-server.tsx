import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'

import { buildHead, escapeHtml, serializeForScript } from './head'
import {
  CARD_IMAGE_SIZES,
  NATURAL_IMAGE_WIDTH,
  PRODUCT_IMAGE_SIZES,
} from './image-config'
import { srcSet } from './storefront-data'
import type { StorefrontPage } from './storefront-root'
import { StorefrontRoot } from './storefront-root'
import { themeStyleSheet } from './theme'

/**
 * Server render.
 *
 * This module is the Vite SSR entry — it is bundled for Node and never reaches a
 * browser. It returns the pieces of the document rather than the whole thing, so
 * the HTTP layer (`server/storefront-server.ts`) stays in charge of caching
 * headers, status codes and asset URLs, which differ between dev and production.
 */

export interface RenderInput {
  data: StorefrontPage
  origin: string
  storageOrigin: string
  path: string
  /** Items in the cart, for the header badge. */
  cartCount?: number
}

export interface RenderOutput {
  /** The app's markup, for the `#root` container. */
  html: string
  /** Title text, already escaped. */
  title: string
  /** Meta/link tags plus JSON-LD. */
  head: string
  /**
   * The store's theme, as a stylesheet body.
   *
   * Returned separately from `head` so the HTTP layer can emit it *after* the app
   * stylesheet. Both declare `--primary` on `:root` with equal specificity, so
   * source order decides — and getting it wrong renders every store in Selld
   * green while the correct colour sits in the document unused.
   */
  themeCss: string
  /** Serialized payload for hydration. */
  state: string
  /** Preload hints, emitted before the stylesheet so they start early. */
  preload: string
  status: number
}

export function render({
  data,
  origin,
  storageOrigin,
  path,
  cartCount = 0,
}: RenderInput): RenderOutput {
  const html = renderToString(
    <StrictMode>
      <StorefrontRoot
        data={data}
        storageOrigin={storageOrigin}
        origin={origin}
        cartCount={cartCount}
      />
    </StrictMode>,
  )

  const head = buildHead({ data, origin, storageOrigin, path })
  const store = storeOf(data)

  const parts: string[] = [head.tags]

  if (head.jsonLd !== null) {
    parts.push(`<script type="application/ld+json">${head.jsonLd}</script>`)
  }

  return {
    html,
    title: escapeHtml(head.title),
    head: parts.join(''),
    // Inlined rather than linked. The theme is one short rule set that every
    // above-the-fold element depends on for its colour; a separate request for it
    // would mean either a flash of Selld green or a blocked first paint.
    themeCss: store === null ? '' : themeStyleSheet(store),
    // `cartCount` has to be here. Leaving it out meant the client hydrated with
    // the default of 0 while the server had rendered a badge — "Did not expect
    // server HTML to contain a <span> in <a>" — and React responded by discarding
    // the entire server-rendered tree and re-rendering from scratch. A silent
    // mismatch like that undoes the whole reason this surface is server-rendered.
    state: serializeForScript({ data, storageOrigin, origin, cartCount }),
    preload: buildPreload({ data, storageOrigin }),
    status: statusFor(data),
  }
}

/**
 * `preconnect` to the storage origin, and `preload` for the LCP image.
 *
 * Storage is a different origin from the store in production, so the first
 * product image otherwise pays for a DNS lookup and a TLS handshake *after* the
 * HTML has already been parsed. On a 150ms-RTT link that is most of a second
 * before the image download even begins.
 */
function buildPreload({
  data,
  storageOrigin,
}: {
  data: StorefrontPage
  storageOrigin: string
}): string {
  const hints: string[] = []

  if (data.route !== 'not-found' && storageOrigin !== '') {
    hints.push(
      `<link rel="preconnect" href="${escapeHtml(storageOrigin)}" crossorigin="anonymous" />`,
    )
  }

  const lcp = lcpImage(data)
  if (lcp !== null) {
    const url = `${storageOrigin.replace(/\/+$/, '')}/storage/v1/object/public/tenant-public/${lcp.path.replace(/^\/+/, '')}`
    const set = srcSet(storageOrigin, lcp.path, lcp.renditions, NATURAL_IMAGE_WIDTH)

    // `imagesrcset`/`imagesizes` have to mirror the <img> exactly. Preloading a
    // bare `href` next to a responsive <img> preloads the *wrong file*: the
    // browser fetches the full-size original for the preload and then separately
    // picks the 400px candidate for the element — paying for both and warming
    // neither. Chrome reports this as "preloaded but not used".
    const responsive =
      set === null
        ? ''
        : ` imagesrcset="${escapeHtml(set)}" imagesizes="${escapeHtml(lcp.sizes)}"`

    hints.push(
      `<link rel="preload" as="image" href="${escapeHtml(url)}"${responsive} fetchpriority="high" />`,
    )
  }

  return hints.join('')
}

interface LcpImage {
  path: string
  renditions: number[]
  /** Must match the `sizes` on the corresponding <img>, or the preload misses. */
  sizes: string
}

/** The single image most likely to be the LCP element, or null if there is none. */
function lcpImage(data: StorefrontPage): LcpImage | null {
  if (data.route === 'product') {
    if (data.payload.product === null) return null
    const image =
      data.payload.images.find((candidate) => candidate.variantId === null) ??
      data.payload.images[0]
    if (image === undefined) return null
    return {
      path: image.path,
      renditions: image.renditions,
      sizes: PRODUCT_IMAGE_SIZES,
    }
  }

  if (data.route === 'home') {
    const hero = data.payload.store.theme.hero?.imagePath
    // A hero image spans the container and has no rendition list of its own.
    if (typeof hero === 'string' && hero.trim() !== '') {
      return { path: hero, renditions: [], sizes: '100vw' }
    }
    const first = data.payload.products.find((product) => product.image !== null)
    if (first?.image === null || first?.image === undefined) return null
    return { path: first.image, renditions: first.renditions, sizes: CARD_IMAGE_SIZES }
  }

  return null
}

function statusFor(data: StorefrontPage): number {
  if (data.route === 'not-found') return 404
  if (data.route === 'product' && data.payload.product === null) return 404
  // An order number that resolves to nothing is a 404 even though the page still
  // renders in the store's branding — the status line is what a link checker and a
  // crawler read, and this URL genuinely has nothing behind it.
  if (data.route === 'track' && data.tracking === null) return 404
  return 200
}

/** Branding for whichever page shape this is. Mirrors `storeOf` in the root. */
function storeOf(data: StorefrontPage) {
  if (data.route === 'home' || data.route === 'product') return data.payload.store
  return data.store ?? null
}
