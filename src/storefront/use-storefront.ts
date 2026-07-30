import { useContext } from 'react'

import { StorefrontContext, type StorefrontContextValue } from './storefront-context'
import { storageUrl } from './storefront-data'

export function useStorefront(): StorefrontContextValue {
  const value = useContext(StorefrontContext)
  if (value === null) {
    throw new Error('useStorefront must be used inside a StorefrontProvider')
  }
  return value
}

/** Resolve a storage path to a public URL against this store's storage origin. */
export function useStorageUrl(): (path: string | null) => string | null {
  const { storageOrigin } = useStorefront()
  return (path) => storageUrl(storageOrigin, path)
}
