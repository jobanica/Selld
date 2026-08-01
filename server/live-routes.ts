import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createLogMessengerProvider, messengerRegistry } from '@/core/messaging'
import { parseComment, type ParseResult } from '@/core/live/parser'

import { guard } from './rate-limit'
import { readServiceConfig } from './payment-webhook'
import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Comments in, claims out.
 *
 * The done-when for this phase is a 200-comment live session producing correct
 * orders with **zero manual encoding**, so this is the path that has to be right:
 * a comment arrives on a webhook, gets parsed, and either holds stock or is shown
 * to the operator as something the parser could not use.
 *
 * ## Why the parse happens here and the reservation does not
 *
 * `parseComment` is a pile of Taglish and Bisaya heuristics that needs a fast edit
 * loop and a scored corpus, so it lives in TypeScript. Holding stock is the thing
 * that must not be wrong when thirty people claim the last two units in the same
 * second, so it stays in SQL where phase 4's sorted advisory locks already solved
 * it. `live_ingest_comment` treats the parse as a *claim about a claim* and
 * re-resolves the code against the session's own items before reserving anything.
 *
 * ## Idempotency
 *
 * Facebook redelivers webhooks routinely — on a timeout, on a 500, sometimes for
 * no reason at all. `live_comments` has a unique index on
 * `(session_id, external_id)`, and a redelivered comment returns `duplicate`
 * without touching stock. An oversold live session is one the seller unwinds by
 * hand while a hundred people watch.
 */

export const LIVE_WEBHOOK_PREFIX = '/api/webhooks/live/'

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

/**
 * One comment, as this server understands it.
 *
 * Deliberately not Facebook's shape. The webhook translates into this, the replay
 * tool produces this, and the operator's "type a comment" box produces this — so
 * one ingest path serves all three and a dry run exercises the real code.
 */
export interface IncomingComment {
  externalId: string
  psid: string
  authorName?: string | null
  body: string
}

/**
 * Pull comments out of a Facebook page webhook.
 *
 * Handles the `feed` change shape, which is what a comment on a live video or a
 * post arrives as. Anything else — a reaction, an edit, a delete, a share — is
 * ignored rather than guessed at: `verb: 'add'` and `item: 'comment'` is the only
 * combination that means somebody said something new.
 */
export function parseFacebookComments(payload: unknown): {
  ref: string | null
  comments: IncomingComment[]
} {
  if (payload === null || typeof payload !== 'object') return { ref: null, comments: [] }
  const body = payload as Record<string, unknown>
  const entries = Array.isArray(body['entry']) ? body['entry'] : []

  const comments: IncomingComment[] = []
  let ref: string | null = null

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const changes = Array.isArray((entry as Record<string, unknown>)['changes'])
      ? ((entry as Record<string, unknown>)['changes'] as unknown[])
      : []

    for (const change of changes) {
      if (change === null || typeof change !== 'object') continue
      const value = (change as Record<string, unknown>)['value']
      if (value === null || typeof value !== 'object') continue
      const comment = value as Record<string, unknown>

      if (comment['item'] !== 'comment' || comment['verb'] !== 'add') continue

      const from = (comment['from'] ?? {}) as Record<string, unknown>
      const externalId = typeof comment['comment_id'] === 'string' ? comment['comment_id'] : ''
      const psid = typeof from['id'] === 'string' ? from['id'] : ''
      const message = typeof comment['message'] === 'string' ? comment['message'] : ''

      // A comment with no author is a page's own reply; with no id there is
      // nothing to deduplicate on, and deduplication is the safety property.
      if (externalId === '' || psid === '') continue

      // The live video, if this is one, otherwise the post. Either is what the
      // seller pasted when they set the session up.
      ref =
        ref ??
        (typeof comment['video_id'] === 'string'
          ? comment['video_id']
          : typeof comment['post_id'] === 'string'
            ? comment['post_id']
            : null)

      comments.push({
        externalId,
        psid,
        authorName: typeof from['name'] === 'string' ? from['name'] : null,
        body: message,
      })
    }
  }

  return { ref, comments }
}

interface LiveSessionRef {
  id: string
  tenantId: string
  status: string
  currentCode: string | null
  codes: string[]
  /** The store's connected Facebook Page, if it has one. Phase 14. */
  pageId?: string | null
}

interface IngestOutcome {
  outcome: string
  commentId?: string
  claims?: { code: string; outcome: string; qty?: number; cartToken?: string }[]
}

/**
 * Parse one comment and hand it to the database.
 *
 * Exported so the webhook, the replay tool and the operator's manual entry box all
 * go through exactly the same code. A replay that took a different path would
 * measure a parser nobody actually runs.
 */
export async function ingestComment(
  service: SupabaseConfig,
  session: LiveSessionRef,
  comment: IncomingComment,
  storeOrigin: string,
): Promise<{ parse: ParseResult; result: IngestOutcome }> {
  const parse = parseComment(comment.body, {
    codes: session.codes,
    currentCode: session.currentCode,
  })

  const result = await rpc<IngestOutcome>(service, 'live_ingest_comment', {
    p_session_id: session.id,
    p_external_id: comment.externalId,
    p_psid: comment.psid,
    p_body: comment.body,
    p_claims: parse.claims,
    p_reason: parse.reason,
    p_author_name: comment.authorName ?? null,
    p_unknown_codes: parse.unknownCodes,
  })

  // The reply is what closes the loop for the buyer: a link that already has the
  // right item in it, so "how do I pay" never becomes a message the seller has to
  // answer thirty times an evening.
  for (const claim of result.claims ?? []) {
    if (claim.outcome !== 'reserved' || claim.cartToken === undefined) continue
    await notifyClaimant(comment.psid, claim, storeOrigin, session).catch(() => {
      // A failed DM must not undo a held claim. The stock is theirs either way,
      // and the operator console shows the link.
    })
  }

  return { parse, result }
}

let registered = false

/** At startup, never at import time — so a test can install a fake. */
export function registerMessengerProviders(): void {
  if (registered) return
  messengerRegistry.register(createLogMessengerProvider())
  registered = true
}

async function notifyClaimant(
  psid: string,
  claim: { code: string; qty?: number; cartToken?: string },
  storeOrigin: string,
  session: LiveSessionRef,
): Promise<void> {
  registerMessengerProviders()

  const message = {
    psid,
    pageId: session.pageId ?? null,
    tenantId: session.tenantId,
    purpose: 'live_claim' as const,
    // Stable per claim, so a webhook redelivery that somehow got this far still
    // cannot double-send.
    idempotencyKey: `${claim.cartToken}`,
    text:
      `Yours! ${claim.code} x${claim.qty ?? 1} is reserved for you. ` +
      `Complete it here: ${storeOrigin}/live/claim/${claim.cartToken}`,
  }

  // Phase 14 registered a provider that can actually send this. It reports
  // `skipped` — not `failed` — when the store has connected no Page, which is the
  // signal to fall back to logging rather than to drop the message: a store on its
  // first live sale has no Page connected and its claims must still work.
  const facebook = messengerRegistry.find('facebook')
  if (facebook !== undefined) {
    const result = await facebook.send(message)
    if (result.status !== 'skipped') return
  }

  const fallback = messengerRegistry.find('log') ?? messengerRegistry.all()[0]
  if (fallback === undefined) return
  await fallback.send(message)
}

/**
 * Facebook's subscription handshake.
 *
 * A GET with `hub.mode=subscribe` and a verify token, answered with the challenge
 * verbatim. Facebook will not deliver a single webhook until this succeeds.
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
 * Verify `X-Hub-Signature-256`.
 *
 * Checked only when `FB_APP_SECRET` is configured — a self-hosted seller running
 * the manual channel has no app at all, and refusing their own replay would be
 * absurd. When the secret *is* set the check is mandatory, because without it the
 * endpoint is "anyone who learns the URL can reserve this seller's stock".
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
 * The live comment webhook.
 *
 * `/api/webhooks/live/{channel}/{secret}` — the same shape as phase 11's courier
 * webhook and for the same reason: the path segment is an unguessable per-platform
 * secret, because the URL is the only thing standing between a stranger and a
 * seller's stock when no app secret is configured.
 */
export async function serveLiveWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeOrigin: string,
): Promise<boolean> {
  if (!url.pathname.startsWith(LIVE_WEBHOOK_PREFIX)) return false

  const rest = url.pathname.slice(LIVE_WEBHOOK_PREFIX.length).split('/')
  const channel = rest[0] ?? ''
  const secret = rest[1] ?? ''
  const expected = process.env['LIVE_WEBHOOK_SECRET'] ?? ''

  if (request.method === 'GET') {
    if (handleVerification(response, url)) return true
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  // A live session is the one public path that is *expected* to burst — 200
  // comments in a minute is the feature working, and the build spec asks for
  // 100 a second. Its own limit, well above that, because a limit below the
  // feature's throughput is the feature switched off in the seller's best hour.
  if (await guard(request, response, 'liveWebhook', channel)) return true

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
    // Acknowledged, not retried: a body that is not JSON will not become JSON.
    send(response, 200, { outcome: 'unparseable' })
    return true
  }

  const { ref, comments } = parseFacebookComments(payload)
  if (comments.length === 0 || ref === null) {
    // 200 rather than 4xx. Facebook disables a subscription that keeps erroring,
    // and "a reaction arrived" is not an error.
    send(response, 200, { outcome: 'ignored' })
    return true
  }

  const session = await rpc<LiveSessionRef | null>(service, 'live_session_for_ref', {
    p_channel: channel,
    p_ref: ref,
  })

  if (session === null) {
    send(response, 200, { outcome: 'no_live_session' })
    return true
  }

  const outcomes: string[] = []
  try {
    for (const comment of comments) {
      const { result } = await ingestComment(service, session, comment, storeOrigin)
      outcomes.push(result.outcome)
    }
  } catch {
    // The one 5xx. Redelivery is safe — the unique index makes it a no-op — and a
    // database that was briefly unreachable is exactly what a retry fixes.
    send(response, 503, { error: 'ingest_failed' })
    return true
  }

  send(response, 200, { outcome: 'ok', comments: outcomes })
  return true
}
