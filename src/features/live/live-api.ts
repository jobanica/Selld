import { parseComment } from '@/core/live/parser'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Live selling, seller side.
 *
 * The operator console polls `live_console` and nothing else — one function, one
 * round trip, because this screen refreshes every couple of seconds while a person
 * is on camera and five queries is five chances for one of them to be the slow one.
 *
 * Manually typed comments go through `parseComment` in the browser and then through
 * the *same* `live_ingest_comment` the webhook uses. A second path would be a second
 * parser to keep in step, and the one the operator exercises during setup would not
 * be the one that runs when the comments actually arrive.
 */

export interface LiveItem {
  id: string
  code: string
  variantId: string
  name: string
  variantLabel: string | null
  price: number
  allocated: number | null
  claimed: number
  remaining: number
  isCurrent: boolean
}

export interface LiveClaim {
  id: string
  code: string
  qty: number
  psid: string
  buyerName: string | null
  status: 'reserved' | 'converted' | 'expired' | 'cancelled'
  expiresAt: string
  orderId: string | null
  createdAt: string
  comment: string | null
}

export interface LiveUnmatched {
  id: string
  body: string
  psid: string
  authorName: string | null
  outcome: string
  receivedAt: string
}

export interface LiveConsole {
  id: string
  title: string
  status: 'draft' | 'live' | 'ended'
  channel: string
  externalRef: string | null
  claimWindowMinutes: number
  currentCode: string | null
  startedAt: string | null
  endedAt: string | null
  totals: {
    claims: number
    units: number
    buyers: number
    converted: number
    expired: number
    value: number
  }
  items: LiveItem[]
  claims: LiveClaim[]
  unmatched: LiveUnmatched[]
}

export interface LiveSessionSummary {
  id: string
  title: string
  status: 'draft' | 'live' | 'ended'
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  itemCount: number
  claimCount: number
}

export async function fetchSessions(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<LiveSessionSummary[]> {
  const { data, error } = await client.rpc('live_sessions_list', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as LiveSessionSummary[]
}

export async function fetchConsole(
  sessionId: string,
  client: SelldClient = getSupabase(),
): Promise<LiveConsole | null> {
  const { data, error } = await client.rpc('live_console', { p_session_id: sessionId })
  if (error) throw error
  return data as unknown as LiveConsole | null
}

export async function createSession(
  input: { tenantId: string; title: string; externalRef: string | null; windowMinutes: number },
  client: SelldClient = getSupabase(),
): Promise<LiveConsole> {
  const { data, error } = await client.rpc('live_session_create', {
    p_tenant_id: input.tenantId,
    p_title: input.title,
    p_channel: input.externalRef === null || input.externalRef === '' ? 'manual' : 'facebook',
    ...(input.externalRef === null || input.externalRef === ''
      ? {}
      : { p_external_ref: input.externalRef }),
    p_window_minutes: input.windowMinutes,
  })
  if (error) throw error
  return data as unknown as LiveConsole
}

export async function addItem(
  input: { sessionId: string; variantId: string; code: string; allocated: number | null },
  client: SelldClient = getSupabase(),
): Promise<LiveConsole> {
  const { data, error } = await client.rpc('live_item_add', {
    p_session_id: input.sessionId,
    p_variant_id: input.variantId,
    p_claim_code: input.code,
    ...(input.allocated === null ? {} : { p_allocated: input.allocated }),
  })
  if (error) throw error
  return data as unknown as LiveConsole
}

export async function updateSession(
  input: { sessionId: string; status?: 'draft' | 'live' | 'ended'; currentCode?: string },
  client: SelldClient = getSupabase(),
): Promise<LiveConsole> {
  const { data, error } = await client.rpc('live_session_update', {
    p_session_id: input.sessionId,
    ...(input.status === undefined ? {} : { p_status: input.status }),
    ...(input.currentCode === undefined ? {} : { p_current_code: input.currentCode }),
  })
  if (error) throw error
  return data as unknown as LiveConsole
}

export async function cancelClaim(
  claimId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('live_claim_cancel', { p_claim_id: claimId })
  if (error) throw error
}

/**
 * A comment the operator typed in, put through the real pipeline.
 *
 * Used when a seller is running the manual channel — no Facebook app connected,
 * they are watching their own comments and typing the ones that matter — and to
 * rehearse a session before going live. It parses in the browser and ingests
 * through the same function the webhook calls, so what the operator sees during a
 * rehearsal is exactly what will happen on the night.
 */
export async function ingestManualComment(
  input: {
    sessionId: string
    codes: string[]
    currentCode: string | null
    psid: string
    authorName: string | null
    body: string
  },
  client: SelldClient = getSupabase(),
): Promise<{ outcome: string }> {
  const parse = parseComment(input.body, {
    codes: input.codes,
    currentCode: input.currentCode,
  })

  const { data, error } = await client.rpc('live_ingest_manual', {
    p_session_id: input.sessionId,
    // Synthetic and stable per (buyer, text): an operator who taps twice on a slow
    // connection must not claim twice, and the unique index is what stops it.
    p_external_id: `manual:${input.psid}:${input.body}`.slice(0, 200),
    p_psid: input.psid,
    p_body: input.body,
    p_claims: parse.claims as never,
    p_reason: parse.reason,
    ...(input.authorName === null ? {} : { p_author_name: input.authorName }),
    p_unknown_codes: parse.unknownCodes as never,
  })
  if (error) throw error
  return data as unknown as { outcome: string }
}

/**
 * Every sellable variant, flat.
 *
 * The board is built from *variants*, not products: a live seller holds up one
 * specific blouse in one specific size, and putting a product on the board would
 * make "mine A1" ambiguous the moment there is more than one size.
 *
 * Archived and draft products are excluded — a code pointing at something the shop
 * is not selling would take an order Selld cannot fulfil.
 */
export interface LiveVariantOption {
  id: string
  label: string
  price: number
}

export async function fetchLiveVariants(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<LiveVariantOption[]> {
  const { data, error } = await client
    .from('product_variants')
    .select('id, sku, price_centavos, products!inner(name, status)')
    .eq('tenant_id', tenantId)
    .eq('products.status', 'active')
    .order('created_at')
  if (error) throw error

  return (data ?? []).map((row) => {
    const product = row.products as unknown as { name: string } | null
    return {
      id: row.id,
      label: `${product?.name ?? ''}${row.sku === null ? '' : ` · ${row.sku}`}`,
      price: row.price_centavos ?? 0,
    }
  })
}

export function describeLiveError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('live_items_code_idx')) return 'live.errorDuplicateCode'
  if (message.includes('live_items_claim_code_check')) return 'live.errorBadCode'
  if (message.includes('No item with code')) return 'live.errorUnknownCode'
  if (message.includes('Not allowed')) return 'live.errorNotAllowed'
  if (message.includes('live_sessions_external_idx')) return 'live.errorDuplicateRef'
  return 'live.errorUnknown'
}
