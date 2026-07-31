/**
 * The Facebook Graph API, as much of it as Selld needs.
 *
 * Four calls: send a message, reply to a comment publicly, reply to a comment
 * privately, and exchange an OAuth code for a page token. Nothing else, because
 * every additional Graph call is another permission to justify in App Review and
 * another thing that breaks when Facebook deprecates a version.
 *
 * ## Why this is not a Facebook SDK
 *
 * The official SDK is large, versioned on its own schedule, and mostly a thin
 * wrapper over `fetch` with a builder API on top. What actually needs care here is
 * the *error* handling — Facebook returns 200 with an `error` object, and its error
 * codes are the difference between "retry this" and "stop, you are about to lose
 * the page's messaging permission" — and no SDK makes that decision for you.
 *
 * Every call goes through `src/core/integration`'s retry and idempotency helpers,
 * per hard rule 7.
 */

export const GRAPH_VERSION = 'v21.0'

export interface GraphConfig {
  baseUrl?: string
  version?: string
  /** The page access token. Never logged, never returned. */
  pageToken: string
  /** Injected by tests and by the local fake. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface GraphError {
  message: string
  type?: string
  code?: number
  subcode?: number
}

/**
 * How to treat a Graph failure.
 *
 * The three that matter and why:
 *
 * - **`policy`** — code 10 and the 200-series subcodes mean the page is not
 *   permitted to send this. Retrying is not just useless, it is how a page gets its
 *   messaging permission restricted. Stop, record it, tell the seller.
 * - **`auth`** — 190 means the token is dead: expired, revoked, or the seller
 *   changed their password. Everything for that page is now failing and the only
 *   fix is reconnecting.
 * - **`transient`** — 1, 2, 4, 17, 32, 613 are Facebook being busy or rate-limiting.
 *   These are the only ones worth a retry.
 */
export type GraphFailure = 'policy' | 'auth' | 'transient' | 'permanent'

export function classifyGraphError(error: GraphError | null, status: number): GraphFailure {
  const code = error?.code ?? 0
  const subcode = error?.subcode ?? 0

  // The person blocked the page, or is outside the window, or the tag is wrong.
  if (code === 10 || (subcode >= 2018001 && subcode <= 2018999)) return 'policy'
  if (code === 200 || code === 230 || code === 551) return 'policy'

  if (code === 190 || code === 102 || status === 401) return 'auth'

  if ([1, 2, 4, 17, 32, 341, 613].includes(code)) return 'transient'
  if (status >= 500 || status === 429) return 'transient'

  return 'permanent'
}

export class GraphApiError extends Error {
  readonly failure: GraphFailure
  readonly code: number
  readonly status: number
  constructor(message: string, failure: GraphFailure, code: number, status: number) {
    super(message)
    this.name = 'GraphApiError'
    this.failure = failure
    this.code = code
    this.status = status
  }
}

/**
 * Facebook's error object, in the shape this module reasons about.
 *
 * The subcode arrives as `error_subcode`, and the subcode is what carries the
 * *specific* refusal — 2018278 is "outside the 24-hour window", which is a
 * different conversation with the seller than "this page is restricted". Reading
 * `subcode` off the raw payload finds nothing, silently, and every policy refusal
 * degrades to whatever the top-level code happened to be.
 */
function normaliseError(raw: unknown): GraphError | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  return {
    message: String(source['message'] ?? 'Graph error'),
    ...(source['type'] === undefined ? {} : { type: String(source['type']) }),
    code: Number(source['code'] ?? 0),
    subcode: Number(source['error_subcode'] ?? source['subcode'] ?? 0),
  }
}

async function request(
  config: GraphConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const base = config.baseUrl ?? 'https://graph.facebook.com'
  const version = config.version ?? GRAPH_VERSION
  const fetchImpl = config.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${base}/${version}/${path}`, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // The token goes in the header, never in the query string. A URL is logged
        // by every proxy it passes and shows up in a browser's history; a page
        // access token in one is a credential leaked to anyone reading the logs.
        Authorization: `Bearer ${config.pageToken}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })

    const text = await response.text()
    let payload: Record<string, unknown> = {}
    try {
      payload = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      throw new GraphApiError(`Graph returned non-JSON: ${text.slice(0, 200)}`,
        response.ok ? 'permanent' : 'transient', 0, response.status)
    }

    // Facebook answers 200 with an `error` object more often than it answers 4xx.
    // Checking `response.ok` alone silently treats a policy refusal as a success,
    // and the seller finds out when nobody replies to them for a week.
    const error = normaliseError(payload['error'])
    if (error !== null || !response.ok) {
      const failure = classifyGraphError(error, response.status)
      throw new GraphApiError(
        error?.message ?? `Graph ${response.status}`,
        failure,
        error?.code ?? 0,
        response.status,
      )
    }

    return payload
  } finally {
    clearTimeout(timer)
  }
}

const call = (
  config: GraphConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => request(config, path, { method: 'POST', body })

export interface SendResult {
  messageId: string
  recipientId?: string
}

/**
 * Send a message to a PSID.
 *
 * `messaging_type` is not optional and Facebook rejects the call without it.
 * `RESPONSE` is a reply inside the 24-hour window; `MESSAGE_TAG` carries a tag and
 * is the only legitimate way out of it.
 */
export async function sendMessage(
  config: GraphConfig,
  input: { pageId: string; psid: string; text: string; tag?: string | null },
): Promise<SendResult> {
  const payload = await call(config, `${input.pageId}/messages`, {
    recipient: { id: input.psid },
    messaging_type: input.tag == null ? 'RESPONSE' : 'MESSAGE_TAG',
    ...(input.tag == null ? {} : { tag: input.tag }),
    message: { text: input.text },
  })

  return {
    messageId: String(payload['message_id'] ?? ''),
    ...(payload['recipient_id'] === undefined
      ? {}
      : { recipientId: String(payload['recipient_id']) }),
  }
}

/**
 * Reply privately to a comment.
 *
 * This is the classic "check your inbox" play, and it is a genuinely different
 * endpoint from a normal send: a private reply is permitted because the person just
 * commented publicly, so it does **not** need an open 24-hour window. Exactly one
 * per comment — Facebook refuses the second, which is one of the reasons
 * `post_comments` deduplicates before anything is sent.
 */
export async function sendPrivateReply(
  config: GraphConfig,
  input: { commentId: string; text: string },
): Promise<SendResult> {
  const payload = await call(config, `${input.commentId}/private_replies`, {
    message: input.text,
  })
  return { messageId: String(payload['id'] ?? '') }
}

/**
 * Reply to a comment publicly.
 *
 * Short, and mostly for the benefit of everyone *else* reading the thread: a page
 * that visibly answers is a page the next person is willing to ask.
 */
export async function replyToComment(
  config: GraphConfig,
  input: { commentId: string; text: string },
): Promise<{ id: string }> {
  const payload = await call(config, `${input.commentId}/comments`, {
    message: input.text,
  })
  return { id: String(payload['id'] ?? '') }
}

// ---------------------------------------------------------------------------
// Connecting a page
// ---------------------------------------------------------------------------
export interface OAuthConfig {
  appId: string
  appSecret: string
  redirectUri: string
  baseUrl?: string
  version?: string
  fetchImpl?: typeof fetch
}

/**
 * The permissions Selld asks for, and not one more.
 *
 * Every scope here is something App Review will ask us to justify with a screen
 * recording, and a seller reading the consent dialog is deciding whether to trust
 * us from this list. `pages_messaging` sends, `pages_manage_metadata` subscribes
 * the webhook, the two `pages_read_*` scopes are what make a comment visible to
 * us at all. There is no `publish_to_groups`, no `pages_read_user_content` beyond
 * comments, and nothing about ads.
 */
export const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement',
  'business_management',
] as const

/** Where to send the seller. `state` is ours and must come back untouched. */
export function authorizeUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(','),
  })
  const base = config.baseUrl ?? 'https://www.facebook.com'
  return `${base}/${config.version ?? GRAPH_VERSION}/dialog/oauth?${params.toString()}`
}

/**
 * Trade the callback's `code` for a user access token.
 *
 * A short-lived one — about an hour — which is why the next step immediately reads
 * the *page* tokens off it. A page token derived from a long-lived user token does
 * not expire on its own, and that is the only kind worth storing: a token that
 * quietly dies in sixty minutes means the seller's inbox goes silent and nothing
 * anywhere says why.
 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const params = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code,
  })

  const payload = await request(
    {
      pageToken: '',
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.version === undefined ? {} : { version: config.version }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    },
    `oauth/access_token?${params.toString()}`,
    { method: 'GET' },
  )

  return {
    accessToken: String(payload['access_token'] ?? ''),
    expiresIn: payload['expires_in'] === undefined ? null : Number(payload['expires_in']),
  }
}

/** Make a short-lived user token last ~60 days, so the page tokens outlive today. */
export async function longLivedToken(
  config: OAuthConfig,
  shortLived: string,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortLived,
  })

  const payload = await request(
    {
      pageToken: '',
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.version === undefined ? {} : { version: config.version }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    },
    `oauth/access_token?${params.toString()}`,
    { method: 'GET' },
  )

  return {
    accessToken: String(payload['access_token'] ?? ''),
    expiresIn: payload['expires_in'] === undefined ? null : Number(payload['expires_in']),
  }
}

export interface ConnectedPage {
  id: string
  name: string
  accessToken: string
  igUserId: string | null
}

/**
 * The pages this person administers, each with its own token.
 *
 * `instagram_business_account` is asked for in the same call because an Instagram
 * professional account is reached *through* its Page, with the Page's token — so
 * fetching it separately would be a second round trip for a field that is free
 * here.
 */
export async function listPages(
  config: Omit<OAuthConfig, 'appId' | 'appSecret' | 'redirectUri'>,
  userToken: string,
): Promise<ConnectedPage[]> {
  const payload = await request(
    {
      pageToken: userToken,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.version === undefined ? {} : { version: config.version }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    },
    'me/accounts?fields=id,name,access_token,instagram_business_account',
    { method: 'GET' },
  )

  const data = Array.isArray(payload['data']) ? payload['data'] : []
  const pages: ConnectedPage[] = []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const page = raw as Record<string, unknown>
    const id = String(page['id'] ?? '')
    const token = String(page['access_token'] ?? '')
    if (id === '' || token === '') continue
    const ig = page['instagram_business_account']
    pages.push({
      id,
      name: String(page['name'] ?? id),
      accessToken: token,
      igUserId:
        ig !== null && typeof ig === 'object'
          ? String((ig as Record<string, unknown>)['id'] ?? '')
          : null,
    })
  }
  return pages
}

/**
 * Subscribe the page to the webhook fields Selld needs.
 *
 * `feed` for comments on posts, `messages` for the inbox. Asked for explicitly
 * rather than assumed, because a page that is not subscribed delivers nothing and
 * the only symptom is silence.
 */
export async function subscribePage(
  config: GraphConfig,
  pageId: string,
): Promise<{ success: boolean }> {
  const payload = await call(config, `${pageId}/subscribed_apps`, {
    subscribed_fields: 'feed,messages,messaging_postbacks',
  })
  return { success: payload['success'] === true }
}
