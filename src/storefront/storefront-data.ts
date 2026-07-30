import { fromDb, type Centavos } from '@/lib/money'

/**
 * The storefront's read model — the exact shape the `storefront_*` RPCs return.
 *
 * This module is imported by both the server renderer and the hydrated client,
 * so it must stay free of anything Node-only or DOM-only. It also deliberately
 * does not import `@supabase/supabase-js`: the server talks to PostgREST with
 * plain `fetch` (see `server/supabase-rpc.ts`) and the client never fetches at
 * all, because the payload is inlined into the HTML. Keeping the client library
 * out of this file is what keeps it out of the buyer's bundle.
 */

export interface StoreTheme {
  preset?: 'clean' | 'bold' | 'warm' | 'mono'
  colors?: { primary?: string; accent?: string }
  fonts?: { headline?: string; body?: string }
  hero?: { headline?: string; subheadline?: string; imagePath?: string }
  customCss?: string | null
}

export interface Store {
  id: string
  name: string
  slug: string
  customDomain: string | null
  logoPath: string | null
  brandColor: string | null
  locale: 'en' | 'tl'
  theme: StoreTheme
}

export interface ProductCard {
  id: string
  name: string
  slug: string
  categoryName: string | null
  categorySlug: string | null
  createdAt: string
  /** Cheapest variant. Equal to `priceTo` when the product has one price. */
  priceFrom: number | null
  priceTo: number | null
  compareAt: number | null
  inStock: boolean
  image: string | null
  imageAlt: string | null
  /** Widths that exist alongside `image`. See `srcSet`. */
  renditions: number[]
}

export interface CategoryFacet {
  name: string
  slug: string
  count: number
}

export interface HomePayload {
  store: Store
  products: ProductCard[]
  categories: CategoryFacet[]
  productCount: number
}

export interface ProductImage {
  id: string
  variantId: string | null
  path: string
  alt: string | null
  renditions: number[]
}

export interface ProductOption {
  id: string
  name: string
  values: { id: string; value: string }[]
}

export interface ProductVariant {
  id: string
  sku: string | null
  price: number
  compareAt: number | null
  optionValueIds: string[]
  inStock: boolean
  stockState: 'ok' | 'low' | 'out'
}

export interface ProductDetail {
  id: string
  name: string
  slug: string
  description: string | null
  categoryName: string | null
  categorySlug: string | null
  isCodAllowed: boolean
  weightGrams: number | null
  createdAt: string
}

export interface ProductPayload {
  store: Store
  product: ProductDetail | null
  images: ProductImage[]
  options: ProductOption[]
  variants: ProductVariant[]
  related: ProductCard[]
}

/** What the server hands the renderer, and what gets inlined for hydration. */
export type PageData =
  | { route: 'home'; payload: HomePayload; query: { category: string | null; search: string | null } }
  | { route: 'product'; payload: ProductPayload }
  | { route: 'not-found'; store: Store | null; hostname: string }

/**
 * Money arrives from PostgREST as a plain JSON number of centavos. Brand it
 * before it can reach a formatter, so an accidental peso value is a type error
 * rather than a store that quietly prices everything at 1/100th.
 */
export function price(value: number | null | undefined): Centavos | null {
  return value === null || value === undefined ? null : fromDb(value)
}

/**
 * Public URL for a storage object in the `tenant-public` bucket.
 *
 * Built by string concatenation rather than `supabase.storage.from().getPublicUrl()`
 * on purpose — that would pull the client library into the buyer's bundle to
 * produce a URL we already know the shape of.
 */
export function storageUrl(supabaseUrl: string, path: string | null): string | null {
  if (path === null || path.trim() === '') return null
  // Already absolute (a seller could paste a full URL in a future admin field).
  if (/^https?:\/\//i.test(path)) return path
  const clean = path.replace(/^\/+/, '')
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/tenant-public/${clean}`
}

/**
 * Path of a downscaled rendition: `products/foo.png` at 400 -> `products/foo@400.png`.
 *
 * The suffix goes before the extension so the file keeps its type, and so the
 * original path remains a valid `src` for any image that has no renditions.
 */
export function renditionPath(path: string, width: number): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? `${path}@${width}` : `${path.slice(0, dot)}@${width}${path.slice(dot)}`
}

/**
 * A `srcset` for an image, or null when there is nothing to choose between.
 *
 * Only widths the database says exist are listed. Guessing at a rendition URL
 * would put a 404 in the candidate list, and a 404 in `srcset` is a broken image
 * — the browser does not fall back to another candidate.
 *
 * `naturalWidth` describes the original so it can be offered as the largest
 * candidate; it is the seed's 900px today and whatever the upload pipeline
 * produces later.
 */
export function srcSet(
  supabaseUrl: string,
  path: string | null,
  renditions: number[],
  naturalWidth: number,
): string | null {
  if (path === null || renditions.length === 0) return null
  const candidates = [...new Set([...renditions, naturalWidth])]
    .filter((width) => width > 0)
    .sort((a, b) => a - b)
  if (candidates.length < 2) return null

  return candidates
    .map((width) => {
      const url = storageUrl(supabaseUrl, width === naturalWidth ? path : renditionPath(path, width))
      return url === null ? null : `${url} ${width}w`
    })
    .filter((entry): entry is string => entry !== null)
    .join(', ')
}

/**
 * The price line for a card: a single price, or a range when variants differ.
 *
 * A range matters. Showing only the cheapest variant next to a product whose
 * other sizes cost more reads as a bait-and-switch when the buyer reaches
 * checkout and the number has changed.
 */
export function priceRange(card: Pick<ProductCard, 'priceFrom' | 'priceTo'>): {
  from: Centavos | null
  to: Centavos | null
  isRange: boolean
} {
  const from = price(card.priceFrom)
  const to = price(card.priceTo)
  return { from, to, isRange: from !== null && to !== null && from !== to }
}

/**
 * Which variant a set of chosen option values resolves to.
 *
 * Compared as sets, not as ordered arrays: `option_value_ids` is stored in
 * option order, but the picker's selection map has no inherent order, and
 * comparing them positionally would fail for any product with two options
 * depending on which one the buyer tapped first.
 */
export function matchVariant(
  variants: ProductVariant[],
  selected: Record<string, string>,
): ProductVariant | null {
  const wanted = Object.values(selected).filter((id) => id !== '')
  if (wanted.length === 0) return variants.length === 1 ? (variants[0] ?? null) : null

  return (
    variants.find((variant) => {
      if (variant.optionValueIds.length !== wanted.length) return false
      return wanted.every((id) => variant.optionValueIds.includes(id))
    }) ?? null
  )
}

/**
 * Whether any in-stock variant uses this option value.
 *
 * Drives greying out — the sold-out value stays visible and disabled. Hiding it
 * makes the product look like it was never offered in that size, which is how a
 * buyer concludes the store is badly stocked rather than temporarily out.
 */
export function isOptionValueAvailable(
  variants: ProductVariant[],
  valueId: string,
  selected: Record<string, string>,
  optionId: string,
): boolean {
  // Hold every *other* selected option fixed, then ask whether this value has a
  // buyable variant under those constraints. Ignoring the rest of the selection
  // would mark Medium available because Medium/Red exists, even when the buyer
  // has already chosen Blue and Medium/Blue is gone.
  const constraints = Object.entries(selected)
    .filter(([key, value]) => key !== optionId && value !== '')
    .map(([, value]) => value)

  return variants.some(
    (variant) =>
      variant.inStock &&
      variant.optionValueIds.includes(valueId) &&
      constraints.every((id) => variant.optionValueIds.includes(id)),
  )
}
