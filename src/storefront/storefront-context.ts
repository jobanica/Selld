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
}

/**
 * Context, provider and hook live in three files by project convention —
 * `react-refresh/only-export-components` requires a module to export components
 * or other values, not both.
 */
export const StorefrontContext = createContext<StorefrontContextValue | null>(null)
