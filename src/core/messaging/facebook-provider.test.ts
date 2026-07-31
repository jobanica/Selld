import { describe, expect, it, vi } from 'vitest'

import { createFacebookMessengerProvider } from './facebook-provider'
import type { OutboundMessage } from './types'

const message: OutboundMessage = {
  psid: '999',
  pageId: '123',
  tenantId: '00000000-0000-0000-0000-000000000001',
  text: 'Here po ang link',
  purpose: 'auto_reply',
  idempotencyKey: 'tenant|messenger.send|comment-1|0',
}

function respondWith(bodies: { status?: number; body: unknown }[]): {
  impl: typeof fetch
  count: () => number
} {
  let index = 0
  const impl = vi.fn(async () => {
    const next = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200 })
  })
  return { impl: impl as unknown as typeof fetch, count: () => index }
}

describe('the Facebook messenger provider', () => {
  it('sends, and reports the platform message id back', async () => {
    const { impl } = respondWith([{ body: { message_id: 'mid.1' } }])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl,
    })

    expect(await provider.send(message)).toEqual({
      provider: 'facebook',
      status: 'sent',
      providerRef: 'mid.1',
    })
  })

  it('skips rather than fails when the page is not connected', async () => {
    // A page with no token is a configuration state, not a send failure. Recording
    // it as a failure per message buries the one fact the seller needs.
    const { impl, count } = respondWith([{ body: {} }])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => null,
      fetchImpl: impl,
    })

    const result = await provider.send(message)
    expect(result.status).toBe('skipped')
    expect(result.error).toBe('no_token')
    expect(count()).toBe(0)
  })

  it('never retries a policy refusal', async () => {
    // The load-bearing one. `withRetry` retries anything it does not recognise, so
    // without the explicit `shouldRetry` a page that has been told "you may not
    // send this" says it again on a backoff curve — which is precisely how the
    // messaging permission goes away.
    const { impl, count } = respondWith([
      { body: { error: { message: 'outside window', code: 10, error_subcode: 2018278 } } },
    ])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl,
      attempts: 4,
    })

    const result = await provider.send(message)
    expect(result.status).toBe('failed')
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('policy')
    expect(count()).toBe(1)
  })

  it('does retry a transient one, and succeeds on the second attempt', async () => {
    const { impl, count } = respondWith([
      { status: 503, body: { error: { message: 'busy', code: 2 } } },
      { body: { message_id: 'mid.2' } },
    ])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl,
      attempts: 3,
    })

    const result = await provider.send(message)
    expect(result.status).toBe('sent')
    expect(count()).toBe(2)
  })

  it('reports a dead token as auth, so the seller is told to reconnect', async () => {
    const { impl } = respondWith([{ body: { error: { message: 'expired', code: 190 } } }])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl,
    })

    expect((await provider.send(message)).error).toContain('auth')
  })

  it('uses the private-reply endpoint when the send answers a comment', async () => {
    const calls: string[] = []
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ id: 'mid.private' }), { status: 200 })
    })
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl as unknown as typeof fetch,
    })

    await provider.send({ ...message, purpose: 'comment_reply', replyToCommentId: 'COMMENT-1' })
    expect(calls[0]).toContain('/COMMENT-1/private_replies')
  })

  it('logs one integration attempt per send, with the attempt count', async () => {
    const entries: { status: string; attempt: number; operation: string }[] = []
    const { impl } = respondWith([
      { status: 500, body: { error: { message: 'oops', code: 2 } } },
      { body: { message_id: 'mid.3' } },
    ])
    const provider = createFacebookMessengerProvider({
      tokenFor: async () => 'TOKEN',
      baseUrl: 'https://graph.test',
      fetchImpl: impl,
      attempts: 3,
      onAttempt: (entry) =>
        entries.push({
          status: entry.status,
          attempt: entry.attempt,
          operation: entry.operation,
        }),
    })

    await provider.send(message)
    expect(entries).toEqual([{ status: 'success', attempt: 2, operation: 'messenger.send' }])
  })
})
