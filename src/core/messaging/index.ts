import { ProviderRegistry } from '@/core/integration/registry'

import type { MessengerProvider } from './types'

export * from './types'
export { createLogMessengerProvider } from './log-provider'
export {
  createFacebookMessengerProvider,
  type FacebookMessengerOptions,
} from './facebook-provider'

/**
 * Implementations register at startup, never at import time — the project
 * convention that lets a test install a fake.
 *
 * Phase 14 registered the Send API provider alongside the logging one. The
 * live-selling call site did not change: it asks the registry for a provider and
 * gets whichever is configured, which is the point of the registry.
 */
export const messengerRegistry = new ProviderRegistry<string, MessengerProvider>('messenger')
