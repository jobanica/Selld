import { ProviderRegistry } from '@/core/integration/registry'

import type { SmsProvider, SmsProviderId } from './types'

export * from './types'

/** Semaphore lands in phase 11 alongside tracking notifications. */
export const smsRegistry = new ProviderRegistry<SmsProviderId, SmsProvider>('sms')
