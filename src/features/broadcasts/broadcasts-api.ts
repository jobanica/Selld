import type { SegmentDefinition } from '@/features/customers/customers-api'
import { tidyDefinition } from '@/features/customers/customers-api'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Broadcasts and vouchers, seller side.
 *
 * The preview is an RPC rather than arithmetic in the browser, and that is a
 * deliberate cost decision: the number of SMS segments a body takes decides what
 * the seller is charged, and a number the client computed is a number the client
 * could get wrong — or, on a different day, lie about. `sms_segments()` in SQL is
 * the one that spends the credits, so it is the one that quotes for them.
 */

export interface BroadcastPreview {
  segments: number
  total: number
  messenger: number
  sms: number
  unreachable: number
  credits: number
  balance: number
  affordable: boolean
}

export async function previewBroadcast(
  input: {
    tenantId: string
    definition: SegmentDefinition
    body: string
    channel: string
    /** The voucher the send will carry, so `{{code}}` is measured at its real length. */
    discountId: string | null
  },
  client: SelldClient = getSupabase(),
): Promise<BroadcastPreview> {
  const { data, error } = await client.rpc('broadcast_preview', {
    p_tenant_id: input.tenantId,
    p_definition: tidyDefinition(input.definition) as never,
    p_body: input.body,
    p_channel: input.channel,
    // Omitted rather than sent as null, and only safe because `broadcast_preview`
    // has exactly one signature: PostgREST resolves an overload from the set of
    // argument *names* in the body, so a key that is absent is a key it never
    // sees. Add a second overload and this call silently picks the wrong one.
    ...(input.discountId === null ? {} : { p_discount_id: input.discountId }),
  })
  if (error) throw error
  return data as unknown as BroadcastPreview
}

export interface BroadcastRow {
  id: string
  name: string
  status: string
  channel: string
  body: string
  recipients: number
  sent: number
  skipped: number
  credits: number
  clicks: number
  scheduledAt: string | null
  startedAt: string | null
  createdAt: string
}

export async function fetchBroadcasts(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<BroadcastRow[]> {
  const { data, error } = await client.rpc('broadcasts_list', {
    p_tenant_id: tenantId,
    p_limit: 30,
  })
  if (error) throw error
  return (data ?? []) as unknown as BroadcastRow[]
}

export interface BroadcastReport extends BroadcastRow {
  failed: number
  bySms: number
  byMessenger: number
  windowDays: number
  attributed: { orders: number; revenue: number }
  redeemed: { orders: number; revenue: number; discount: number }
}

export async function fetchReport(
  broadcastId: string,
  client: SelldClient = getSupabase(),
): Promise<BroadcastReport | null> {
  const { data, error } = await client.rpc('broadcast_report', {
    p_broadcast_id: broadcastId,
    p_window_days: 7,
  })
  if (error) throw error
  return data as unknown as BroadcastReport | null
}

export async function saveBroadcast(
  input: {
    tenantId: string
    name: string
    body: string
    definition: SegmentDefinition
    channel: string
    discountId: string | null
  },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client.rpc('broadcast_save', {
    p_tenant_id: input.tenantId,
    p_name: input.name,
    p_body: input.body,
    p_definition: tidyDefinition(input.definition) as never,
    p_channel: input.channel,
    ...(input.discountId === null ? {} : { p_discount_id: input.discountId }),
  })
  if (error) throw error
  return data as unknown as string
}

/**
 * Send it.
 *
 * Through the server, because the page tokens and the SMS provider credentials
 * are the server's. Called repeatedly while `remaining` is true — a request that
 * tried to push 800 messages in one go is a request that times out halfway
 * through, and the seller would have no way to tell which half.
 */
export async function sendBroadcast(
  broadcastId: string,
  onProgress?: (sent: number) => void,
  client: SelldClient = getSupabase(),
): Promise<{ sent: number; failed: number; skipped: number }> {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token ?? ''

  let sent = 0
  let failed = 0
  let skipped = 0

  for (let round = 0; round < 50; round += 1) {
    const response = await fetch(`/api/broadcasts/${broadcastId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(payload.error ?? 'send_failed')
    }
    const outcome = (await response.json()) as {
      sent: number
      failed: number
      skipped: number
      remaining: boolean
    }
    sent += outcome.sent
    failed += outcome.failed
    skipped += outcome.skipped
    onProgress?.(sent)
    if (!outcome.remaining) break
  }

  return { sent, failed, skipped }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------
export interface DiscountRow {
  id: string
  code: string | null
  name: string
  kind: 'percent' | 'fixed' | 'free_shipping'
  value: number
  min_subtotal_centavos: number
  used_count: number
  usage_limit: number | null
  usage_limit_per_customer: number | null
  is_auto: boolean
  is_active: boolean
  ends_at: string | null
}

export async function fetchDiscounts(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<DiscountRow[]> {
  const { data, error } = await client
    .from('discounts')
    .select(
      'id, code, name, kind, value, min_subtotal_centavos, used_count, usage_limit, usage_limit_per_customer, is_auto, is_active, ends_at',
    )
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as DiscountRow[]
}

export async function createDiscount(
  input: {
    tenantId: string
    code: string
    name: string
    kind: 'percent' | 'fixed' | 'free_shipping'
    /** Percent as a whole number, fixed as pesos. Converted here, once. */
    value: number
    minSubtotalPesos: number
    perCustomer: number | null
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('discounts').insert({
    tenant_id: input.tenantId,
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    kind: input.kind,
    // Basis points for a percentage, centavos for a fixed amount — integer
    // arithmetic on the way in, per hard rule 2, so nothing downstream has to
    // guess which unit it is holding.
    value:
      input.kind === 'percent'
        ? Math.round(input.value * 100)
        : input.kind === 'fixed'
          ? Math.round(input.value) * 100
          : 0,
    min_subtotal_centavos: Math.round(input.minSubtotalPesos) * 100,
    usage_limit_per_customer: input.perCustomer,
  })
  if (error) throw error
}

export async function setDiscountActive(
  input: { id: string; isActive: boolean },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client
    .from('discounts')
    .update({ is_active: input.isActive })
    .eq('id', input.id)
  if (error) throw error
}

export function describeBroadcastError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('discounts_code_check')) return 'broadcasts.errorBadCode'
  if (message.includes('discounts_code_idx')) return 'broadcasts.errorDuplicateCode'
  if (message.includes('broadcasts_body_check')) return 'broadcasts.errorBadBody'
  if (message.includes('not_allowed') || message.includes('Not allowed'))
    return 'broadcasts.errorNotAllowed'
  if (message.includes('not_configured')) return 'broadcasts.errorNotConfigured'
  return 'broadcasts.errorUnknown'
}
