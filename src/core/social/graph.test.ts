import { describe, expect, it, vi } from 'vitest'

import {
  classifyGraphError,
  GraphApiError,
  replyToComment,
  sendMessage,
  sendPrivateReply,
} from './graph'

/** A `fetch` that answers with one canned response and records what it was asked. */
function fakeFetch(response: { status?: number; body: unknown }): {
  impl: typeof fetch
  calls: { url: string; body: Record<string, unknown> }[]
} {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const config = (impl: typeof fetch) => ({
  pageToken: 'PAGE-TOKEN',
  baseUrl: 'https://graph.test',
  fetchImpl: impl,
})

describe('classifyGraphError()', () => {
  it('calls a 200-series code a policy failure, not something to retry', () => {
    // Code 200 is "the page does not have permission to send this". Retrying it is
    // how a page's messaging permission gets restricted.
    expect(classifyGraphError({ message: 'no permission', code: 200 }, 200)).toBe('policy')
    expect(classifyGraphError({ message: 'blocked', code: 10 }, 200)).toBe('policy')
    expect(classifyGraphError({ message: 'outside window', subcode: 2018278 }, 200)).toBe('policy')
  })

  it('calls an expired token an auth failure', () => {
    expect(classifyGraphError({ message: 'expired', code: 190 }, 200)).toBe('auth')
    expect(classifyGraphError(null, 401)).toBe('auth')
  })

  it('retries only what is actually transient', () => {
    expect(classifyGraphError({ message: 'busy', code: 2 }, 200)).toBe('transient')
    expect(classifyGraphError({ message: 'rate limited', code: 613 }, 200)).toBe('transient')
    expect(classifyGraphError(null, 503)).toBe('transient')
    expect(classifyGraphError(null, 429)).toBe('transient')
  })

  it('treats an unrecognised code as permanent rather than retrying forever', () => {
    expect(classifyGraphError({ message: 'no such user', code: 100 }, 400)).toBe('permanent')
  })
})

describe('sendMessage()', () => {
  it('sends inside the window as RESPONSE, with no tag', async () => {
    const { impl, calls } = fakeFetch({ body: { message_id: 'mid.1', recipient_id: '999' } })
    const result = await sendMessage(config(impl), {
      pageId: '123',
      psid: '999',
      text: 'Yours!',
    })

    expect(result.messageId).toBe('mid.1')
    expect(calls[0]?.url).toBe('https://graph.test/v21.0/123/messages')
    expect(calls[0]?.body['messaging_type']).toBe('RESPONSE')
    expect(calls[0]?.body).not.toHaveProperty('tag')
  })

  it('switches to MESSAGE_TAG when a tag is given', async () => {
    // `messaging_type: RESPONSE` plus a tag is rejected, and a tag with no
    // messaging_type is silently treated as standard — which is the policy
    // violation, not an error we would see.
    const { impl, calls } = fakeFetch({ body: { message_id: 'mid.2' } })
    await sendMessage(config(impl), {
      pageId: '123',
      psid: '999',
      text: 'Your parcel is out for delivery',
      tag: 'POST_PURCHASE_UPDATE',
    })

    expect(calls[0]?.body['messaging_type']).toBe('MESSAGE_TAG')
    expect(calls[0]?.body['tag']).toBe('POST_PURCHASE_UPDATE')
  })

  it('throws on a 200 that carries an error object', async () => {
    // The trap this whole module exists for. Facebook answers 200 far more often
    // than it answers 4xx, so `response.ok` alone reads a policy refusal as a
    // successful send and the seller finds out a week later.
    const { impl } = fakeFetch({
      status: 200,
      body: { error: { message: 'outside window', code: 10, error_subcode: 2018278 } },
    })

    const failure = await sendMessage(config(impl), {
      pageId: '123',
      psid: '999',
      text: 'hello',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GraphApiError)
    expect((failure as GraphApiError).failure).toBe('policy')
    expect((failure as GraphApiError).code).toBe(10)
  })

  it('reads the refusal out of `error_subcode`, which is where Facebook puts it', async () => {
    // The subcode is what carries the *specific* refusal, and it arrives under
    // `error_subcode`, not `subcode`. Read the wrong key and this — "outside the
    // 24-hour window" — degrades to whatever the top-level code happened to be,
    // which here is a transient one: the send would be retried on a backoff curve
    // against a page that has already said no.
    const { impl, calls } = fakeFetch({
      body: { error: { message: 'not allowed', code: 1, error_subcode: 2018278 } },
    })

    const failure = await sendMessage(config(impl), {
      pageId: '123',
      psid: '999',
      text: 'hello',
    }).catch((error: unknown) => error)

    expect((failure as GraphApiError).failure).toBe('policy')
    expect(calls).toHaveLength(1)
  })

  it('does not mistake a non-JSON body for a successful send', async () => {
    const impl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    const failure = await sendMessage(
      { pageToken: 't', baseUrl: 'https://graph.test', fetchImpl: impl as unknown as typeof fetch },
      { pageId: '1', psid: '2', text: 'hi' },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GraphApiError)
    expect((failure as GraphApiError).failure).toBe('transient')
  })
})

describe('the comment endpoints', () => {
  it('replies privately through /private_replies, which needs no open window', async () => {
    const { impl, calls } = fakeFetch({ body: { id: 'mid.private' } })
    const result = await sendPrivateReply(config(impl), {
      commentId: 'COMMENT-1',
      text: 'Here po ang link',
    })

    expect(calls[0]?.url).toBe('https://graph.test/v21.0/COMMENT-1/private_replies')
    expect(calls[0]?.body['message']).toBe('Here po ang link')
    expect(result.messageId).toBe('mid.private')
  })

  it('replies publicly through /comments', async () => {
    const { impl, calls } = fakeFetch({ body: { id: 'COMMENT-1_reply' } })
    await replyToComment(config(impl), { commentId: 'COMMENT-1', text: 'Check your inbox po 💬' })

    expect(calls[0]?.url).toBe('https://graph.test/v21.0/COMMENT-1/comments')
  })
})
