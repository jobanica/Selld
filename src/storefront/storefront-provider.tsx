import type { ReactNode } from 'react'

import { StorefrontContext, type StorefrontContextValue } from './storefront-context'

export function StorefrontProvider({
  value,
  children,
}: {
  value: StorefrontContextValue
  children: ReactNode
}) {
  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>
}
