import type { MessengerProvider, MessengerResult, OutboundMessage } from './types'

/**
 * The `log` messenger.
 *
 * Writes to the console and reports success, so the live-selling path is a real,
 * exercised code path from phase 13 onward rather than a stub that gets wired up
 * for the first time — and discovered to be wrong — in phase 14 when the Send API
 * lands.
 *
 * Same reasoning as `src/core/sms/log-provider.ts`, and the same trap avoided:
 * a provider that silently no-ops lets an entire feature ship untested.
 */
export function createLogMessengerProvider(): MessengerProvider {
  return {
    id: 'log',
    async send(message: OutboundMessage): Promise<MessengerResult> {
      console.log(`[messenger:log] -> ${message.psid} (${message.purpose}) ${message.text}`)
      return { provider: 'log', status: 'sent', providerRef: message.idempotencyKey }
    },
  }
}
