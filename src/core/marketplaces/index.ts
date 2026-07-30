import { ProviderRegistry } from '@/core/integration/registry'

import type { MarketplaceId, MarketplaceProvider } from './types'

export * from './types'

/** Implementations arrive in phase 17 — and not before 10 sellers ask for it. */
export const marketplaceRegistry = new ProviderRegistry<MarketplaceId, MarketplaceProvider>(
  'marketplace',
)
