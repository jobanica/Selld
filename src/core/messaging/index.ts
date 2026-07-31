import { ProviderRegistry } from '@/core/integration/registry'

import type { MessengerProvider } from './types'

export * from './types'
export { createLogMessengerProvider } from './log-provider'

/**
 * Implementations register at startup, never at import time — the project
 * convention that lets a test install a fake.
 *
 * The Messenger Send API provider lands in phase 14 with the OAuth that makes a
 * page access token available. Nothing in `server/live-routes.ts` changes when it
 * does, which is the point of the registry.
 */
export const messengerRegistry = new ProviderRegistry<string, MessengerProvider>('messenger')
