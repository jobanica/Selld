import { ProviderRegistry } from '@/core/integration/registry'

import type { PaymentProvider, PaymentProviderId } from './types'

export * from './types'

/** Xendit, COD, and manual-record implementations arrive in phase 8. */
export const paymentRegistry = new ProviderRegistry<PaymentProviderId, PaymentProvider>(
  'payment',
)
