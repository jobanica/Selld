import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * The unified inbox, seller side.
 *
 * Two functions and one endpoint: `inbox_threads` for the list, `inbox_thread` for
 * a conversation, and `POST /api/social/reply` for sending — because sending needs
 * a page access token, and a page access token must never reach a browser. The rule
 * is the same one phase 10 applied to courier credentials.
 */

export interface InboxThread {
  id: string
  platform: 'facebook' | 'instagram'
  psid: string
  name: string
  snippet: string | null
  lastMessageAt: string | null
  lastInboundAt: string | null
  unread: number
  status: 'open' | 'closed'
  customerId: string | null
  customerName: string | null
  customerOrders: number | null
  /**
   * Hours left in Facebook's standard messaging window, or null when the person
   * has never written to us.
   *
   * On every row on purpose. An agent working through an inbox has to see which
   * conversations are about to close *before* choosing which to answer — a reply
   * written at hour 25 is a reply that cannot be sent, and discovering that after
   * typing it is how people learn to distrust a tool.
   */
  windowHoursLeft: number | null
}

export interface InboxMessage {
  id: string
  direction: 'in' | 'out'
  body: string | null
  source: 'user' | 'agent' | 'auto_reply' | 'comment_reply' | 'system'
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'blocked'
  tag: string | null
  error: string | null
  sentAt: string
}

export interface InboxConversation {
  id: string
  platform: 'facebook' | 'instagram'
  psid: string
  name: string
  status: 'open' | 'closed'
  customerId: string | null
  customer: { name: string; phone: string; orders: number } | null
  sendWindow: {
    verdict: 'standard' | 'tagged' | 'blocked'
    reason?: string
    hoursLeft?: number
    closedAt?: string
  }
  messages: InboxMessage[]
}

export async function fetchThreads(
  tenantId: string,
  status: 'open' | 'closed' | 'all' = 'open',
  client: SelldClient = getSupabase(),
): Promise<InboxThread[]> {
  const { data, error } = await client.rpc('inbox_threads', {
    p_tenant_id: tenantId,
    p_status: status,
    p_limit: 50,
  })
  if (error) throw error
  return (data ?? []) as unknown as InboxThread[]
}

export async function fetchConversation(
  threadId: string,
  client: SelldClient = getSupabase(),
): Promise<InboxConversation | null> {
  const { data, error } = await client.rpc('inbox_thread', {
    p_thread_id: threadId,
    p_limit: 100,
  })
  if (error) throw error
  return data as unknown as InboxConversation | null
}

export async function markRead(
  threadId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('inbox_mark_read', { p_thread_id: threadId })
  if (error) throw error
}

/**
 * Send a reply the seller typed.
 *
 * Through the server, with the seller's own access token attached: the server
 * checks the thread is readable under *that* token before it uses the page's, so a
 * JWT for another store cannot reach a stranger's conversation.
 */
export async function sendReply(
  input: { threadId: string; body: string; tag?: string | null },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token ?? ''

  const response = await fetch('/api/social/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      threadId: input.threadId,
      body: input.body,
      tag: input.tag ?? null,
    }),
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      reason?: string
    }
    throw new Error(payload.reason ?? payload.error ?? 'send_failed')
  }
}

// ---------------------------------------------------------------------------
// Auto-replies
// ---------------------------------------------------------------------------
export interface AutoReplyRule {
  id: string
  keyword: string
  match_type: 'word' | 'contains' | 'exact'
  body: string
  is_active: boolean
  priority: number
  channel: 'message' | 'comment' | 'both'
}

export async function fetchAutoReplies(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<AutoReplyRule[]> {
  const { data, error } = await client
    .from('auto_replies')
    .select('id, keyword, match_type, body, is_active, priority, channel')
    .eq('tenant_id', tenantId)
    .order('priority', { ascending: false })
    .order('keyword')
  if (error) throw error
  return (data ?? []) as AutoReplyRule[]
}

export async function saveAutoReply(
  input: {
    tenantId: string
    id: string | null
    keyword: string
    body: string
    channel: 'message' | 'comment' | 'both'
    matchType: 'word' | 'contains' | 'exact'
    isActive: boolean
    priority: number
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const row = {
    tenant_id: input.tenantId,
    keyword: input.keyword.trim(),
    body: input.body.trim(),
    channel: input.channel,
    match_type: input.matchType,
    is_active: input.isActive,
    priority: input.priority,
  }

  const { error } =
    input.id === null
      ? await client.from('auto_replies').insert(row)
      : await client.from('auto_replies').update(row).eq('id', input.id)
  if (error) throw error
}

export async function deleteAutoReply(
  id: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('auto_replies').delete().eq('id', id)
  if (error) throw error
}

/** What a rule would actually send, with the placeholders filled in. */
export async function previewAutoReply(
  input: { tenantId: string; text: string; channel: 'message' | 'comment' },
  client: SelldClient = getSupabase(),
): Promise<{ keyword: string; body: string } | null> {
  const { data, error } = await client.rpc('auto_reply_for', {
    p_tenant_id: input.tenantId,
    p_text: input.text,
    p_channel: input.channel,
    // `p_root_url` is deliberately left off, so the preview renders the link a
    // buyer would actually receive — `https://{slug}.selld.ph`, the database's own
    // default — rather than whatever host the seller happens to have the dashboard
    // open on. Safe to omit only because nothing overloads this name: PostgREST
    // resolves an overload by the set of argument *names* in the body, and a
    // missing key is a 404 against a function that is right there.
  })
  if (error) throw error
  return data as unknown as { keyword: string; body: string } | null
}

// ---------------------------------------------------------------------------
// Connected pages
// ---------------------------------------------------------------------------
export interface ConnectedAccount {
  id: string
  platform: 'facebook' | 'instagram'
  page_id: string
  page_name: string | null
  ig_user_id: string | null
  has_token: boolean
  token_expired: boolean
  webhook_subscribed: boolean
  connected_at: string
}

export async function fetchAccounts(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<ConnectedAccount[]> {
  const { data, error } = await client
    .from('social_accounts_safe')
    .select(
      'id, platform, page_id, page_name, ig_user_id, has_token, token_expired, webhook_subscribed, connected_at',
    )
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
  if (error) throw error
  return (data ?? []) as ConnectedAccount[]
}

/** Where Facebook should send the seller. The server mints the signed state. */
export async function startConnect(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data } = await client.auth.getSession()
  const response = await fetch('/api/social/oauth/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session?.access_token ?? ''}`,
    },
    body: JSON.stringify({ tenantId }),
  })
  if (!response.ok) throw new Error(String(response.status))
  const payload = (await response.json()) as { url: string }
  return payload.url
}

export async function disconnectAccount(
  accountId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('social_account_disconnect', { p_account_id: accountId })
  if (error) throw error
}

export function describeInboxError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('window_closed')) return 'inbox.errorWindowClosed'
  if (message.includes('never_messaged_us')) return 'inbox.errorNeverMessaged'
  if (message.includes('tag_needs_a_human')) return 'inbox.errorTagNeedsHuman'
  if (message.includes('no_page')) return 'inbox.errorNoPage'
  if (message.includes('not_configured')) return 'inbox.errorNotConfigured'
  if (message.includes('Not allowed')) return 'inbox.errorNotAllowed'
  if (message.includes('auto_replies_keyword_check')) return 'inbox.errorBadKeyword'
  if (message.includes('auto_replies_body_check')) return 'inbox.errorBadBody'
  return 'inbox.errorUnknown'
}
