import { withRetry } from '@/core/integration/retry'
import {
  GraphApiError,
  sendMessage,
  sendPrivateReply,
  type GraphConfig,
} from '@/core/social/graph'

import type { MessengerProvider, MessengerResult, OutboundMessage } from './types'

/**
 * The Messenger Send API, behind the phase-13 port.
 *
 * ## Where the token comes from
 *
 * Not from here. A page access token can post as the seller, read their inbox and
 * message their customers, so it lives encrypted in `social_accounts` and is
 * fetched by the server through a service-role RPC. This provider asks for one by
 * page id and never holds onto it: `tokenFor` is called per send, so a seller who
 * reconnects a page does not have to restart the process, and a token that has been
 * revoked stops working immediately rather than at the next deploy.
 *
 * ## What is retried, and what is very deliberately not
 *
 * `withRetry`'s default is to retry anything it does not recognise, which is right
 * for a network blip and badly wrong here. A `policy` failure — the person blocked
 * the page, the window is closed, the tag does not cover this — will fail the same
 * way forever, and hammering it is exactly the behaviour that gets a page's
 * messaging permission restricted. Only `transient` is retried.
 *
 * An `auth` failure is not retried either, but it *is* different in kind: the token
 * is dead and every send for that page is now failing. It is reported as such so
 * the inbox can tell the seller to reconnect instead of showing them a hundred
 * identical send failures.
 */

export interface FacebookMessengerOptions {
  /**
   * Resolve the page access token for a page. Returns null when the page is not
   * connected, or is connected without a usable token.
   */
  tokenFor: (pageId: string) => Promise<string | null>
  baseUrl?: string
  version?: string
  fetchImpl?: typeof fetch
  /** Retries. Two by default: Messenger is a foreground path with a 5s budget. */
  attempts?: number
  /** Wired to `log_integration_attempt` by the server. */
  onAttempt?: (entry: {
    tenantId: string | null
    operation: string
    idempotencyKey: string
    status: 'success' | 'failed'
    attempt: number
    durationMs: number
    errorCode?: string
    errorMessage?: string
  }) => void
}

export function createFacebookMessengerProvider(
  options: FacebookMessengerOptions,
): MessengerProvider {
  return {
    id: 'facebook',

    async send(message: OutboundMessage): Promise<MessengerResult> {
      const pageId = message.pageId ?? ''
      if (pageId === '') {
        return { provider: 'facebook', status: 'skipped', error: 'no_page' }
      }

      const token = await options.tokenFor(pageId)
      if (token === null || token === '') {
        // Not a failure of this message. The page is not connected, and telling
        // the seller that once is worth more than telling them per message.
        return { provider: 'facebook', status: 'skipped', error: 'no_token' }
      }

      const config: GraphConfig = {
        pageToken: token,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }

      const operation =
        message.replyToCommentId == null ? 'messenger.send' : 'messenger.private_reply'
      const startedAt = Date.now()
      let attempts = 0

      try {
        const result = await withRetry(
          async () => {
            attempts += 1
            if (message.replyToCommentId != null) {
              return await sendPrivateReply(config, {
                commentId: message.replyToCommentId,
                text: message.text,
              })
            }
            return await sendMessage(config, {
              pageId,
              psid: message.psid,
              text: message.text,
              tag: message.tag ?? null,
            })
          },
          {
            attempts: options.attempts ?? 2,
            baseDelayMs: 300,
            maxDelayMs: 2_000,
            shouldRetry: (error) =>
              error instanceof GraphApiError ? error.failure === 'transient' : true,
          },
        )

        options.onAttempt?.({
          tenantId: message.tenantId ?? null,
          operation,
          idempotencyKey: message.idempotencyKey,
          status: 'success',
          attempt: attempts,
          durationMs: Date.now() - startedAt,
        })

        return { provider: 'facebook', status: 'sent', providerRef: result.messageId }
      } catch (error) {
        const failure = error instanceof GraphApiError ? error.failure : 'transient'
        const code = error instanceof GraphApiError ? String(error.code) : 'network'
        const description = error instanceof Error ? error.message : String(error)

        options.onAttempt?.({
          tenantId: message.tenantId ?? null,
          operation,
          idempotencyKey: message.idempotencyKey,
          status: 'failed',
          attempt: attempts,
          durationMs: Date.now() - startedAt,
          errorCode: `${failure}:${code}`,
          errorMessage: description.slice(0, 500),
        })

        return {
          provider: 'facebook',
          status: 'failed',
          error: `${failure}: ${description}`,
          retryable: failure === 'transient',
        }
      }
    },
  }
}
