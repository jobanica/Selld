import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorHint, errorMessage } from '@/lib/supabase/errors'

/**
 * The seller's privacy desk.
 *
 * Two queues and a toggle, and none of the rules are here. Whether a request may
 * be served, what erasure actually removes, and who is allowed to record a breach
 * are all decided in the database — this file asks and renders, like every other
 * feature slice.
 */

export type DsrKind = 'export' | 'deletion' | 'correction'
export type DsrStatus = 'open' | 'served' | 'refused' | 'withdrawn'

export interface DataSubjectRequest {
  id: string
  kind: DsrKind
  phone: string
  email: string | null
  note: string | null
  status: DsrStatus
  requestedAt: string
  dueAt: string
  servedAt: string | null
  outcome: { customers?: number; orders?: number; messages?: number; method?: string } | null
  refusedReason: string | null
  overdue: boolean
}

export async function fetchRequests(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<DataSubjectRequest[]> {
  const { data, error } = await client.rpc('dsr_list', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as DataSubjectRequest[]
}

export async function openRequest(
  input: { tenantId: string; kind: DsrKind; phone: string; email?: string; note?: string },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client.rpc('dsr_open', {
    p_tenant_id: input.tenantId,
    p_kind: input.kind,
    p_phone: input.phone,
    ...(input.email === undefined || input.email === '' ? {} : { p_email: input.email }),
    ...(input.note === undefined || input.note === '' ? {} : { p_note: input.note }),
  })
  if (error) throw error
  return data as unknown as string
}

export async function closeRequest(
  input: { requestId: string; status: 'refused' | 'withdrawn'; reason?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('dsr_close', {
    p_request_id: input.requestId,
    p_status: input.status,
    ...(input.reason === undefined ? {} : { p_reason: input.reason }),
  })
  if (error) throw error
}

/**
 * Everything one phone number touches, as a document.
 *
 * Downloaded in the browser rather than emailed, deliberately: this is the most
 * concentrated piece of personal data the product can produce, and putting it in
 * an inbox puts a copy on a mail server nobody in this system controls.
 */
export async function exportSubject(
  tenantId: string,
  phone: string,
  client: SelldClient = getSupabase(),
): Promise<unknown> {
  const { data, error } = await client.rpc('dsr_export', {
    p_tenant_id: tenantId,
    p_phone: phone,
  })
  if (error) throw error
  return data
}

export async function serveDeletion(
  requestId: string,
  client: SelldClient = getSupabase(),
): Promise<{ customers: number; orders: number; messages: number }> {
  const { data, error } = await client.rpc('dsr_serve_deletion', { p_request_id: requestId })
  if (error) throw error
  return data as unknown as { customers: number; orders: number; messages: number }
}

export interface BreachEntry {
  id: string
  tenantId: string | null
  nature: string
  description: string
  discoveredAt: string
  notifyDueAt: string
  severity: 'unknown' | 'low' | 'medium' | 'high'
  status: 'open' | 'contained' | 'notified' | 'closed'
  affectedCount: number | null
  dataCategories: string[]
  npcNotifiedAt: string | null
  subjectsNotifiedAt: string | null
  overdue: boolean
}

export async function fetchBreaches(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<BreachEntry[]> {
  const { data, error } = await client.rpc('breach_list', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as BreachEntry[]
}

export async function recordBreach(
  input: {
    tenantId: string
    nature: string
    description: string
    discoveredAt: string
    affectedCount?: number
    severity?: string
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('breach_record', {
    p_nature: input.nature,
    p_description: input.description,
    p_discovered_at: input.discoveredAt,
    p_tenant_id: input.tenantId,
    ...(input.affectedCount === undefined ? {} : { p_affected_count: input.affectedCount }),
    ...(input.severity === undefined ? {} : { p_severity: input.severity }),
  })
  if (error) throw error
}

export async function markNotified(
  id: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('breach_update', {
    p_id: id,
    p_status: 'notified',
    p_npc_notified_at: new Date().toISOString(),
    p_subjects_notified_at: new Date().toISOString(),
  })
  if (error) throw error
}

export async function setMarketingConsent(
  input: { tenantId: string; customerId: string; granted: boolean; note?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('set_marketing_consent', {
    p_tenant_id: input.tenantId,
    p_customer_id: input.customerId,
    p_granted: input.granted,
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

/** Is this customer still reachable with marketing? */
export async function mayMarket(
  tenantId: string,
  customerId: string,
  client: SelldClient = getSupabase(),
): Promise<boolean> {
  const { data, error } = await client.rpc('customer_may_market', {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
  })
  if (error) throw error
  return data as unknown as boolean
}

export function describePrivacyError(error: unknown): string {
  // Hint first: it is the contract the migration raises, and the message is
  // prose somebody will improve. See CLAUDE.md.
  const text = `${errorHint(error)} ${errorMessage(error)}`
  if (text.includes('wrong_request_kind')) return 'privacy.errorWrongKind'
  if (text.includes('request_closed')) return 'privacy.errorClosed'
  if (text.includes('Not allowed') || text.includes('insufficient_privilege')) {
    return 'privacy.errorNotAllowed'
  }
  return 'privacy.errorUnknown'
}
