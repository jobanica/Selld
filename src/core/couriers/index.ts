import { ProviderRegistry } from '@/core/integration/registry'

import type { CourierId, CourierProvider } from './types'

export * from './types'

/**
 * Courier implementations land here in phase 10 (J&T and Flash first).
 * Registration happens at app startup, not at import time, so tests can install
 * fakes.
 */
export const courierRegistry = new ProviderRegistry<CourierId, CourierProvider>('courier')
