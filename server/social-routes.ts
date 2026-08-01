import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  createFacebookMessengerProvider,
  createLogMessengerProvider,
  messengerRegistry,
  type MessengerProvider,
  type MessengerResult,
} from '@/core/messaging'
import {
  authorizeUrl,
  exchangeCodeForToken,
  listPages,
  longLivedToken,
  OAUTH_SCOPES,
  replyToComment,
  subscribePage,
  type OAuthConfig,
} from '@/core/social/graph'

import { guard } from './rate-limit'
import { readServiceConfig } from './payment-webhook'
import { readSupabaseConfig, rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Comments and DMs, in — a public reply and a private message, out.
 *
 * The done-when for this phase is a stopwatch: **a comment on any post triggers a
 * DM with the store link within five seconds.** Everything about the order of
 * operations below follows from that number.
 *
 * ## Why the DM goes before the public reply
 *
 * The public "sent you a DM po" is for everyone else reading the thread; the DM is
 * the thing being measured, and the thing the buyer is waiting for. Sending the
 * public one first would put a whole Graph round trip in front of it for no
 * benefit to the person who asked.
 *
 * ## Why the reply is not queued
 *
 * A job queue would be the ordinary answer, and it is the wrong one at five
 * seconds: the queue itself costs a poll interval, and the failure mode of doing
 * it inline — Facebook redelivers when we are slow — is already handled, because
 * `post_comments` deduplicates on Facebook's own comment id before anything is
 * sent. Redelivery is a no-op, so the only cost of being slow is being slow.
 *
 * ## What a failed send does *not* do
 *
 * It does not fail the webhook. Facebook disables a subscription that keeps
 * erroring, and losing the subscription costs the seller every future comment to
 * save this one. Failures are recorded on the comment row and answered 200.
 */

export const SOCIAL_WEBHOOK_PREFIX = '/api/webhooks/social/'

const MAX_BODY_BYTES = 512 * 1024

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------
export interface IncomingPostComment {
  pageId: string
  postId: string
  commentId: string
  parentId: string | null
  psid: string
  authorName: string | null
  body: string
}

export interface IncomingDirectMessage {
  pageId: string
  psid: string
  messageId: string
  body: string
  sentAt: string | null
  attachments: unknown[] | null
}

/**
 * Split a page webhook into the two things this route acts on.
 *
 * Facebook delivers both shapes to the same URL: comments arrive under
 * `entry[].changes` with `field: 'feed'`, messages under `entry[].messaging`. The
 * page id is `entry[].id` and is the only thing tying either to a seller — a PSID
 * without a page is not an identity, it is a number.
 *
 * Anything else is dropped rather than guessed at. A reaction, an edit, a delete,
 * a share and a message the *page* sent all look superficially like the shapes
 * below, and `echo: true` in particular is our own outbound message coming back:
 * recording it as inbound would extend the 24-hour window on the strength of our
 * own reply, which is precisely the compliance claim we must never make.
 */
export function parseSocialPayload(payload: unknown): {
  comments: IncomingPostComment[]
  messages: IncomingDirectMessage[]
} {
  const comments: IncomingPostComment[] = []
  const messages: IncomingDirectMessage[] = []

  if (payload === null || typeof payload !== 'object') return { comments, messages }
  const body = payload as Record<string, unknown>
  const entries = Array.isArray(body['entry']) ? body['entry'] : []

  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const pageId = typeof entry['id'] === 'string' ? entry['id'] : ''
    if (pageId === '') continue

    for (const change of Array.isArray(entry['changes']) ? entry['changes'] : []) {
      if (change === null || typeof change !== 'object') continue
      const record = change as Record<string, unknown>
      if (record['field'] !== 'feed') continue
      const value = record['value']
      if (value === null || typeof value !== 'object') continue
      const comment = value as Record<string, unknown>
      if (comment['item'] !== 'comment' || comment['verb'] !== 'add') continue

      const from = (comment['from'] ?? {}) as Record<string, unknown>
      const commentId = typeof comment['comment_id'] === 'string' ? comment['comment_id'] : ''
      const psid = typeof from['id'] === 'string' ? from['id'] : ''
      // A comment from the page itself is our own reply coming back. Answering it
      // is a page talking to itself, in public, forever.
      if (commentId === '' || psid === '' || psid === pageId) continue

      comments.push({
        pageId,
        postId: typeof comment['post_id'] === 'string' ? comment['post_id'] : pageId,
        commentId,
        parentId: typeof comment['parent_id'] === 'string' ? comment['parent_id'] : null,
        psid,
        authorName: typeof from['name'] === 'string' ? from['name'] : null,
        body: typeof comment['message'] === 'string' ? comment['message'] : '',
      })
    }

    for (const item of Array.isArray(entry['messaging']) ? entry['messaging'] : []) {
      if (item === null || typeof item !== 'object') continue
      const event = item as Record<string, unknown>
      const message = event['message']
      if (message === null || typeof message !== 'object') continue
      const content = message as Record<string, unknown>
      if (content['is_echo'] === true) continue

      const sender = (event['sender'] ?? {}) as Record<string, unknown>
      const psid = typeof sender['id'] === 'string' ? sender['id'] : ''
      const messageId = typeof content['mid'] === 'string' ? content['mid'] : ''
      if (psid === '' || messageId === '' || psid === pageId) continue

      const timestamp = typeof event['timestamp'] === 'number' ? event['timestamp'] : null

      messages.push({
        pageId,
        psid,
        messageId,
        body: typeof content['text'] === 'string' ? content['text'] : '',
        sentAt: timestamp === null ? null : new Date(timestamp).toISOString(),
        attachments: Array.isArray(content['attachments'])
          ? (content['attachments'] as unknown[])
          : null,
      })
    }
  }

  return { comments, messages }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
let registeredFor: SupabaseConfig | null = null

/**
 * Register the send providers at startup, never at import time.
 *
 * `tokenFor` is a closure over the service config rather than a token, so nothing
 * in this process holds a page access token between sends. A seller who reconnects
 * a page — or whose token Facebook revokes — is reflected on the very next message
 * instead of at the next deploy.
 */
export function registerSocialProviders(service: SupabaseConfig): void {
  if (registeredFor === service) return
  registeredFor = service

  const key = process.env['SOCIAL_TOKEN_KEY'] ?? process.env['COURIER_CREDENTIALS_KEY'] ?? ''

  if (messengerRegistry.find('facebook') !== undefined) return
  messengerRegistry.register(
    createFacebookMessengerProvider({
      tokenFor: async (pageId) => {
        if (key === '') return null
        return await rpc<string | null>(service, 'social_page_token', {
          p_platform: 'facebook',
          p_page_id: pageId,
          p_key: key,
        })
      },
      ...(process.env['FB_GRAPH_BASE_URL'] === undefined
        ? {}
        : { baseUrl: process.env['FB_GRAPH_BASE_URL'] }),
      onAttempt: (entry) => {
        if (entry.tenantId === null) return
        // Fire and forget, like every other integration log in this codebase: a
        // failed *log* must not fail the send it is describing.
        void rpc(service, 'log_integration_attempt', {
          p_tenant_id: entry.tenantId,
          p_provider: 'facebook',
          p_operation: entry.operation,
          p_idempotency_key: entry.idempotencyKey,
          p_status: entry.status,
          p_attempt: entry.attempt,
          p_error_code: entry.errorCode ?? null,
          p_error_message: entry.errorMessage ?? null,
          p_duration_ms: entry.durationMs,
        }).catch(() => {})
      },
    }),
  )
  // The logging provider stays registered alongside it. Phase 13's claim
  // confirmations fall back to it when a store has not connected a Page, which is
  // most stores on their first live sale.
  if (messengerRegistry.find('log') === undefined) {
    messengerRegistry.register(createLogMessengerProvider())
  }
}

function messenger(): MessengerProvider | undefined {
  return messengerRegistry.find('facebook') ?? messengerRegistry.all()[0]
}

async function pageToken(service: SupabaseConfig, pageId: string): Promise<string | null> {
  const key = process.env['SOCIAL_TOKEN_KEY'] ?? process.env['COURIER_CREDENTIALS_KEY'] ?? ''
  if (key === '') return null
  return await rpc<string | null>(service, 'social_page_token', {
    p_platform: 'facebook',
    p_page_id: pageId,
    p_key: key,
  }).catch(() => null)
}

// ---------------------------------------------------------------------------
// The comment play
// ---------------------------------------------------------------------------
interface AccountRef {
  id: string
  tenantId: string
  platform: string
  pageId: string
  slug: string
  storeName: string
  hasToken: boolean
}

interface CommentDecision {
  outcome: 'duplicate' | 'no_rule' | 'reply'
  commentId?: string
  tenantId?: string
  psid?: string
  body?: string
  publicBody?: string
  keyword?: string
}

/**
 * One comment: record it, decide, DM, then reply publicly.
 *
 * Exported so the webhook and the proof harness drive exactly the same code. A
 * proof that took a different path would measure a handler nobody runs.
 */
export async function handleComment(
  service: SupabaseConfig,
  account: AccountRef,
  comment: IncomingPostComment,
  rootUrl: string,
): Promise<{ outcome: string; sent: boolean }> {
  const decision = await rpc<CommentDecision>(service, 'record_post_comment', {
    p_account_id: account.id,
    p_post_id: comment.postId,
    p_comment_id: comment.commentId,
    p_psid: comment.psid,
    p_body: comment.body,
    p_author_name: comment.authorName,
    p_parent_id: comment.parentId,
    p_root_url: rootUrl,
  })

  // A redelivery, or a comment no rule matched. Both are the ordinary case and
  // neither sends anything: most comments are "😍" and do not want a robot.
  if (decision.outcome !== 'reply' || decision.commentId === undefined) {
    return { outcome: decision.outcome, sent: false }
  }

  const provider = messenger()
  if (provider === undefined) return { outcome: 'no_provider', sent: false }

  const result = await provider.send({
    psid: comment.psid,
    pageId: account.pageId,
    tenantId: account.tenantId,
    text: decision.body ?? '',
    purpose: 'comment_reply',
    // A private reply, not a message: the person just commented publicly, which is
    // the one basis on which Facebook permits a send with no open 24-hour window.
    replyToCommentId: comment.commentId,
    idempotencyKey: `${account.tenantId}|messenger.private_reply|${comment.commentId}|0`,
  })

  if (result.status === 'sent') {
    await rpc(service, 'record_comment_dm', {
      p_comment_row: decision.commentId,
      p_body: decision.body ?? '',
      p_external_id: result.providerRef ?? null,
    }).catch(() => {
      // The DM is out. Failing to write it into the thread is worth a missing row
      // in the inbox, not a second DM to the buyer.
    })
  }

  await rpc(service, 'record_comment_reply', {
    p_comment_row: decision.commentId,
    p_publicly: false,
    p_privately: result.status === 'sent',
    p_error: result.status === 'sent' ? null : (result.error ?? 'send_failed'),
  }).catch(() => {})

  // The public half, after the measured one. Best effort on purpose: a page that
  // could not comment publicly has still answered the person who asked.
  const token = await pageToken(service, account.pageId)
  if (token !== null && decision.publicBody !== undefined) {
    const publicReply = await replyToComment(
      {
        pageToken: token,
        ...(process.env['FB_GRAPH_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['FB_GRAPH_BASE_URL'] }),
      },
      { commentId: comment.commentId, text: decision.publicBody },
    ).then(
      () => true,
      () => false,
    )
    if (publicReply) {
      await rpc(service, 'record_comment_reply', {
        p_comment_row: decision.commentId,
        p_publicly: true,
        p_privately: false,
        p_error: null,
      }).catch(() => {})
    }
  }

  return { outcome: result.status === 'sent' ? 'replied' : 'send_failed', sent: result.status === 'sent' }
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------
interface InboundResult {
  outcome: 'recorded' | 'duplicate'
  threadId?: string
  autoReply?: { id: string; keyword: string; body: string } | null
  sendWindow?: { verdict: 'standard' | 'tagged' | 'blocked'; reason?: string }
}

/**
 * One DM: record it, and answer it if a keyword rule matches.
 *
 * The auto-reply comes back from `record_inbound_message` rather than from a
 * second call, because the database already had to look at the text to store it
 * and a second round trip buys nothing but latency.
 */
export async function handleMessage(
  service: SupabaseConfig,
  account: AccountRef,
  message: IncomingDirectMessage,
  rootUrl: string,
): Promise<{ outcome: string; replied: boolean }> {
  const recorded = await rpc<InboundResult>(service, 'record_inbound_message', {
    p_account_id: account.id,
    p_psid: message.psid,
    p_external_id: message.messageId,
    p_body: message.body,
    p_name: null,
    p_sent_at: message.sentAt,
    p_attachments: message.attachments === null ? null : JSON.stringify(message.attachments),
    p_root_url: rootUrl,
  })

  if (recorded.outcome === 'duplicate') return { outcome: 'duplicate', replied: false }

  const reply = recorded.autoReply ?? null
  if (reply === null || recorded.threadId === undefined) {
    return { outcome: 'recorded', replied: false }
  }

  // Asked before the send, not after. A message that arrived late enough for its
  // own window to have closed — a redelivery from hours ago, a queue that backed
  // up — must not be answered, and finding that out from
  // `record_outbound_message` afterwards is finding out about a message already
  // delivered.
  if ((recorded.sendWindow?.verdict ?? 'standard') === 'blocked') {
    return { outcome: `window_${recorded.sendWindow?.reason ?? 'closed'}`, replied: false }
  }

  const provider = messenger()
  if (provider === undefined) return { outcome: 'no_provider', replied: false }

  const result = await provider.send({
    psid: message.psid,
    pageId: account.pageId,
    tenantId: account.tenantId,
    text: reply.body,
    purpose: 'auto_reply',
    idempotencyKey: `${account.tenantId}|messenger.send|${message.messageId}|0`,
  })

  // Recorded either way, and `record_outbound_message` is what decides whether a
  // send was permitted at all. A failed send belongs in the thread so the seller
  // can see it did not go — a silent gap reads as "nobody asked".
  await rpc(service, 'record_outbound_message', {
    p_thread_id: recorded.threadId,
    p_body: reply.body,
    p_source: 'auto_reply',
    p_tag: null,
    p_external_id: result.providerRef ?? null,
    p_status: result.status === 'sent' ? 'sent' : 'failed',
    p_error: result.status === 'sent' ? null : (result.error ?? 'send_failed'),
  }).catch(() => {})

  return { outcome: 'replied', replied: result.status === 'sent' }
}

// ---------------------------------------------------------------------------
// Connecting a page
// ---------------------------------------------------------------------------
const OAUTH_START_PATH = '/api/social/oauth/start'
const OAUTH_CALLBACK_PATH = '/api/social/oauth/callback'

function oauthConfig(rootUrl: string): OAuthConfig | null {
  const appId = process.env['FB_APP_ID'] ?? ''
  const appSecret = process.env['FB_APP_SECRET'] ?? ''
  if (appId === '' || appSecret === '') return null
  return {
    appId,
    appSecret,
    // Facebook compares this string byte for byte against the one in the app's
    // settings and against the one sent to the dialog. Deriving it from the
    // request is how it ends up different between the two calls.
    redirectUri: `${process.env['SELLD_PUBLIC_URL'] ?? rootUrl}${OAUTH_CALLBACK_PATH}`,
    ...(process.env['FB_GRAPH_BASE_URL'] === undefined
      ? {}
      : { baseUrl: process.env['FB_GRAPH_BASE_URL'] }),
  }
}

/**
 * The `state` parameter, signed.
 *
 * It carries the tenant the seller was looking at when they pressed connect, and
 * it comes back from Facebook through the seller's own browser — so it is exactly
 * as trustworthy as a query string, which is to say not at all. Signed with the
 * app secret and stamped with an expiry, it is a bearer capability to connect a
 * page to *that* tenant and nothing else. Without the signature, `?state=<any
 * tenant id>` would connect an attacker's page to a stranger's store.
 */
function signState(tenantId: string, expiresAt: number): string {
  const secret = process.env['FB_APP_SECRET'] ?? ''
  const payload = `${tenantId}.${expiresAt}`
  const mac = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${mac}`
}

function verifyState(state: string): string | null {
  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [tenantId, expiry, mac] = parts as [string, string, string]
  const expected = signState(tenantId, Number(expiry)).split('.')[2] ?? ''
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (!Number.isFinite(Number(expiry)) || Number(expiry) < Date.now()) return null
  return tenantId
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

const REPLY_PATH = '/api/social/reply'

/**
 * A person, typing.
 *
 * The dashboard cannot send this itself: a page access token is the server's, and
 * the browser must never hold one. So the reply comes here — and authorisation is
 * still the database's, not this file's. The thread is read under the *caller's*
 * own token first, where `message_threads` carries `is_tenant_member`, so a JWT for
 * another store gets an empty list rather than a stranger's conversation.
 *
 * The window is not re-checked here either. `record_outbound_message` refuses a
 * send it should not have made, so the only way to log one is to have been allowed
 * to make it — and a check in this file would be a second, weaker copy of the rule
 * that the *other* code path does not have.
 */
async function serveAgentReply(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  // One bucket for the endpoint. There is no per-account key available before the
  // signature is checked, and inventing one from the body would let a caller pick
  // their own bucket.
  if (await guard(request, response, 'webhook', 'social')) return true

  const service = readServiceConfig()
  const anon = readSupabaseConfig()
  if (service === null || anon === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  const jwt = bearer(request)
  let body: Record<string, unknown>
  try {
    body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}') as Record<
      string,
      unknown
    >
  } catch {
    send(response, 400, { error: 'bad_request' })
    return true
  }

  const threadId = String(body['threadId'] ?? '')
  const text = String(body['body'] ?? '').trim()
  const tag = body['tag'] === undefined || body['tag'] === null ? null : String(body['tag'])
  if (jwt === '' || !/^[0-9a-f-]{36}$/i.test(threadId) || text === '') {
    send(response, 400, { error: 'bad_request' })
    return true
  }

  const visible = await fetch(
    `${anon.url}/rest/v1/message_threads?id=eq.${threadId}&select=id,psid,tenant_id,social_account_id`,
    { headers: { apikey: anon.anonKey, Authorization: `Bearer ${jwt}` } },
  )
    .then(async (r) => (r.ok ? ((await r.json()) as { id: string }[]) : []))
    .catch(() => [])

  if (visible.length === 0) {
    send(response, 403, { error: 'not_allowed' })
    return true
  }

  const thread = visible[0] as { id: string; psid: string; tenant_id: string }

  // The window, before the send. `record_outbound_message` refuses too, but it
  // refuses *after* — and the seller needs to be told they cannot reply before
  // they watch the message vanish.
  const verdict = await rpc<{ verdict: string; reason?: string }>(
    service,
    'message_send_allowed_raw',
    { p_thread_id: threadId, p_tag: tag, p_automated: false },
  ).catch(() => ({ verdict: 'blocked', reason: 'lookup_failed' }))

  if (verdict.verdict === 'blocked') {
    send(response, 409, { error: 'blocked', reason: verdict.reason ?? 'window_closed' })
    return true
  }

  const account = await rpc<{ pageId: string } | null>(service, 'social_account_for_thread', {
    p_thread_id: threadId,
  }).catch(() => null)

  if (account === null) {
    send(response, 503, { error: 'no_page' })
    return true
  }

  registerSocialProviders(service)
  const provider = messenger()
  const result: MessengerResult = await (provider?.send({
    psid: thread.psid,
    pageId: account.pageId,
    tenantId: thread.tenant_id,
    text,
    purpose: 'agent_reply',
    tag,
    idempotencyKey: `${thread.tenant_id}|messenger.agent|${threadId}|${Date.now()}`,
  }) ??
    Promise.resolve<MessengerResult>({
      provider: 'none',
      status: 'failed',
      error: 'no_provider',
    }))

  const recorded = await rpc<{ outcome: string; reason?: string }>(
    service,
    'record_outbound_message',
    {
      p_thread_id: threadId,
      p_body: text,
      // `agent` is what tells `message_send_allowed` a human is typing, which is
      // the only basis on which HUMAN_AGENT is legitimate.
      p_source: 'agent',
      p_tag: tag,
      p_external_id: result.providerRef ?? null,
      p_status: result.status === 'sent' ? 'sent' : 'failed',
      p_error: result.status === 'sent' ? null : (result.error ?? 'send_failed'),
    },
  ).catch(() => ({ outcome: 'error' }) as { outcome: string; reason?: string })

  if (recorded.outcome === 'blocked') {
    send(response, 409, { error: 'blocked', reason: recorded.reason ?? 'window_closed' })
    return true
  }

  send(response, result.status === 'sent' ? 200 : 502, {
    ok: result.status === 'sent',
    error: result.status === 'sent' ? undefined : result.error,
  })
  return true
}

/**
 * Everything the dashboard needs to connect a Page, plus the redirect back.
 *
 * `start` is a POST with the seller's own JWT, because that is the only point in
 * the flow where we can prove who is asking: the callback arrives as a top-level
 * navigation with no Authorization header at all. So the check happens here, and
 * its result is carried across the round trip by the signed `state`.
 */
export async function serveSocialRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rootUrl: string,
): Promise<boolean> {
  if (url.pathname === REPLY_PATH) return await serveAgentReply(request, response)
  if (url.pathname !== OAUTH_START_PATH && url.pathname !== OAUTH_CALLBACK_PATH) return false

  const config = oauthConfig(rootUrl)
  const service = readServiceConfig()

  if (url.pathname === OAUTH_START_PATH) {
    if (request.method !== 'POST') {
      send(response, 405, { error: 'method_not_allowed' })
      return true
    }
    if (config === null || service === null) {
      send(response, 503, { error: 'not_configured' })
      return true
    }

    const jwt = bearer(request)
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
    } catch {
      send(response, 400, { error: 'bad_request' })
      return true
    }

    const tenantId = String(body['tenantId'] ?? '')
    if (jwt === '' || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
      send(response, 400, { error: 'bad_request' })
      return true
    }

    // Membership is checked by the database under the caller's own token, not by
    // this process: `tenant_members` carries the policy, and a server that decided
    // for itself would be a second, weaker copy of the rule.
    const anon = readSupabaseConfig()
    if (anon === null) {
      send(response, 503, { error: 'not_configured' })
      return true
    }
    const allowed = await fetch(
      `${anon.url}/rest/v1/rpc/has_tenant_role`,
      {
        method: 'POST',
        headers: {
          apikey: anon.anonKey,
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_tenant_id: tenantId, p_min_role: 'admin' }),
      },
    )
      .then(async (r) => (r.ok ? ((await r.json()) as boolean) : false))
      .catch(() => false)

    if (allowed !== true) {
      send(response, 403, { error: 'not_allowed' })
      return true
    }

    const state = signState(tenantId, Date.now() + 10 * 60 * 1000)
    send(response, 200, { url: authorizeUrl(config, state) })
    return true
  }

  // ---- The redirect back ---------------------------------------------------
  if (config === null || service === null) {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  const tenantId = verifyState(url.searchParams.get('state') ?? '')
  const code = url.searchParams.get('code') ?? ''
  if (tenantId === null || code === '') {
    // Includes the seller pressing cancel, which is not an error worth a stack
    // trace — they are sent back to the settings screen either way.
    response.writeHead(303, { Location: '/settings/social?connected=0' }).end()
    return true
  }

  const key = process.env['SOCIAL_TOKEN_KEY'] ?? process.env['COURIER_CREDENTIALS_KEY'] ?? ''
  if (key === '') {
    send(response, 503, { error: 'no_encryption_key' })
    return true
  }

  try {
    const short = await exchangeCodeForToken(config, code)
    // Long-lived first. A page token derived from a token that expires in an hour
    // expires with it, and the seller's inbox goes quiet with nothing to explain it.
    const long = await longLivedToken(config, short.accessToken).catch(() => short)
    const pages = await listPages(config, long.accessToken)

    let connected = 0
    for (const page of pages) {
      const accountId = await rpc<string>(service, 'social_account_connect', {
        p_tenant_id: tenantId,
        p_platform: 'facebook',
        p_page_id: page.id,
        p_page_name: page.name,
        p_ig_user_id: page.igUserId,
        p_scopes: OAUTH_SCOPES,
      }).catch(() => null)

      if (accountId === null) continue

      // Subscribing is what makes Facebook deliver anything at all. A page that is
      // connected but not subscribed looks perfectly fine and is completely silent,
      // so the outcome is stored rather than assumed.
      const subscribed = await subscribePage(
        {
          pageToken: page.accessToken,
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        },
        page.id,
      ).then(
        (result) => result.success,
        () => false,
      )

      await rpc(service, 'set_social_page_token', {
        p_account_id: accountId,
        p_token: page.accessToken,
        p_key: key,
        p_expires_at:
          long.expiresIn === null
            ? null
            : new Date(Date.now() + long.expiresIn * 1000).toISOString(),
        p_subscribed: subscribed,
      })
      connected += 1
    }

    response.writeHead(303, { Location: `/settings/social?connected=${connected}` }).end()
    return true
  } catch {
    response.writeHead(303, { Location: '/settings/social?connected=0&error=1' }).end()
    return true
  }
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------
/**
 * Facebook's subscription handshake. Nothing is delivered until it succeeds.
 */
function handleVerification(response: ServerResponse, url: URL): boolean {
  if (url.searchParams.get('hub.mode') !== 'subscribe') return false

  const expected = process.env['FB_WEBHOOK_VERIFY_TOKEN'] ?? ''
  const given = url.searchParams.get('hub.verify_token') ?? ''
  const challenge = url.searchParams.get('hub.challenge') ?? ''

  if (expected === '' || given !== expected) {
    response.writeHead(403).end()
    return true
  }
  response.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge)
  return true
}

/**
 * Verify `X-Hub-Signature-256`, when there is an app secret to verify it with.
 *
 * Same rule as the live webhook: checked only when `FB_APP_SECRET` is configured,
 * and mandatory when it is. Without either the signature or the unguessable path
 * segment, this endpoint is "anyone who learns the URL can make a seller's page
 * message a stranger".
 */
function signatureValid(raw: Buffer, header: string | undefined): boolean {
  const secret = process.env['FB_APP_SECRET'] ?? ''
  if (secret === '') return true
  if (header === undefined || !header.startsWith('sha256=')) return false

  const expected = createHmac('sha256', secret).update(raw).digest()
  const given = Buffer.from(header.slice('sha256='.length), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * `/api/webhooks/social/{secret}` — page comments and messages.
 *
 * Separate from the live webhook because the two do genuinely different things
 * with the same shape of payload: a live comment reserves stock against a
 * session's board, and this answers a question under a photo. One endpoint that
 * had to decide which it was looking at would be one endpoint that sometimes
 * decided wrong, and deciding wrong means either a DM nobody wanted or a claim
 * nobody made.
 */
export async function serveSocialWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rootUrl: string,
): Promise<boolean> {
  if (!url.pathname.startsWith(SOCIAL_WEBHOOK_PREFIX)) return false

  const secret = url.pathname.slice(SOCIAL_WEBHOOK_PREFIX.length).split('/')[0] ?? ''
  const expected = process.env['SOCIAL_WEBHOOK_SECRET'] ?? ''

  if (request.method === 'GET') {
    if (handleVerification(response, url)) return true
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const service = readServiceConfig()
  if (service === null || expected === '') {
    send(response, 503, { error: 'not_configured' })
    return true
  }

  if (secret.length !== expected.length || secret !== expected) {
    send(response, 404, { error: 'unknown_endpoint' })
    return true
  }

  let raw: Buffer
  try {
    raw = await readRawBody(request)
  } catch {
    send(response, 413, { error: 'too_large' })
    return true
  }

  if (!signatureValid(raw, request.headers['x-hub-signature-256'] as string | undefined)) {
    send(response, 401, { error: 'bad_signature' })
    return true
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    send(response, 200, { outcome: 'unparseable' })
    return true
  }

  const { comments, messages } = parseSocialPayload(payload)
  if (comments.length === 0 && messages.length === 0) {
    // 200, not 4xx: Facebook disables a subscription that keeps erroring, and "a
    // reaction arrived" is not an error.
    send(response, 200, { outcome: 'ignored' })
    return true
  }

  registerSocialProviders(service)

  // One account lookup per page, not per event. A post with forty comments in a
  // burst is one delivery, and forty identical lookups would be forty round trips
  // inside a five-second budget.
  // The *promise* is cached, not the result. Forty comments handled concurrently
  // would otherwise all miss an empty map and fire forty identical lookups.
  const accounts = new Map<string, Promise<AccountRef | null>>()
  const accountFor = (pageId: string): Promise<AccountRef | null> => {
    const cached = accounts.get(pageId)
    if (cached !== undefined) return cached
    const lookup = rpc<AccountRef | null>(service, 'social_account_for_page', {
      p_platform: 'facebook',
      p_page_id: pageId,
    }).catch(() => null)
    accounts.set(pageId, lookup)
    return lookup
  }

  const outcomes: string[] = []
  try {
    /**
     * Handled with a small amount of concurrency, not one at a time.
     *
     * A popular post delivers its comments in bursts, and each one costs two Graph
     * round trips. Serially, the fortieth buyer waits for the other thirty-nine —
     * seven seconds in the phase-14 proof, which fails the done-when for everyone
     * but the first person to comment. Bounded rather than unbounded because a
     * hundred parallel sends to one page is what rate limiting is for, and being
     * rate-limited costs every seller on the deployment, not just this one.
     */
    const CONCURRENCY = 8
    const work: (() => Promise<string>)[] = [
      ...comments.map((comment) => async () => {
        const account = await accountFor(comment.pageId)
        if (account === null) return 'unknown_page'
        return (await handleComment(service, account, comment, rootUrl)).outcome
      }),
      ...messages.map((message) => async () => {
        const account = await accountFor(message.pageId)
        if (account === null) return 'unknown_page'
        return (await handleMessage(service, account, message, rootUrl)).outcome
      }),
    ]

    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
        for (let index = next++; index < work.length; index = next++) {
          outcomes[index] = await (work[index] as () => Promise<string>)()
        }
      }),
    )
  } catch {
    // The one 5xx. Redelivery is safe — every write here deduplicates on the
    // platform's own id — and a database that was briefly unreachable is exactly
    // what a retry fixes.
    send(response, 503, { error: 'handler_failed' })
    return true
  }

  send(response, 200, { outcome: 'ok', events: outcomes })
  return true
}
