import { createContext } from 'react'

import type { Store } from './storefront-data'

export interface StorefrontContextValue {
  store: Store
  /**
   * Origin that serves storage objects. Passed in rather than read from `env`
   * because the server renderer has no `import.meta.env` at request time and
   * because a custom-domain store may eventually front its images differently.
   */
  storageOrigin: string
  /** Absolute origin of this store, for canonical and OG URLs. */
  origin: string
  /**
   * Where this store is mounted on the host — `/store/rhea`, or empty when the
   * store owns the whole origin. Never build a storefront link without it; use
   * `useStoreHref()` rather than reading it directly.
   */
  basePath: string
  /** Items in the cart, for the header badge. */
  cartCount: number
  /**
   * True on the one render that follows an add-to-cart, so the header can play
   * its animation. Part of the payload rather than something the client works
   * out, or the server and the hydrated client would disagree about a class name.
   */
  cartBump: boolean
}

/**
 * Context, provider and hook live in three files by project convention —
 * `react-refresh/only-export-components` requires a module to export components
 * or other values, not both.
 */
export const StorefrontContext = createContext<StorefrontContextValue | null>(null)
