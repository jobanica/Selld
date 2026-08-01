import { useContext } from 'react'

import { storeHref } from '@/lib/tenant/resolve-tenant'

import { StorefrontContext, type StorefrontContextValue } from './storefront-context'
import { storageUrl } from './storefront-data'

export function useStorefront(): StorefrontContextValue {
  const value = useContext(StorefrontContext)
  if (value === null) {
    throw new Error('useStorefront must be used inside a StorefrontProvider')
  }
  return value
}

/**
 * Build a link inside this store.
 *
 * Every `href` and form `action` in the storefront goes through this. Under the
 * subdomain form it returns its argument unchanged, so there is no second code
 * path that could be forgotten — the path-mounted form is exercised by the same
 * line of code as the common one.
 */
export function useStoreHref(): (path: string) => string {
  const { basePath } = useStorefront()
  return (path) => storeHref(basePath, path)
}

/** Resolve a storage path to a public URL against this store's storage origin. */
export function useStorageUrl(): (path: string | null) => string | null {
  const { storageOrigin } = useStorefront()
  return (path) => storageUrl(storageOrigin, path)
}
