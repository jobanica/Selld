import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Couriers, seller side.
 *
 * Two things here are unlike every other API module in `src/features`.
 *
 * **Credentials never travel through the browser's Supabase client.** They are
 * encrypted with a key the server holds and this file cannot read, so connecting a
 * courier posts to the Node server rather than to PostgREST. A credential the
 * browser can hold is one a seller's browser extension can read.
 *
 * **Booking is a server call for the same reason** — it needs those credentials —
 * and it carries the seller's own Supabase access token, which the server hands
 * straight back to PostgREST so the *database* decides whether they may book.
 */

export type CourierId = 'jnt' | 'flash' | 'lbc' | 'ninja'

export interface CourierAccount {
  id: string
  courier: CourierId
  accountRef: string | null
  isLive: boolean
  isEnabled: boolean
  connectedAt: string | null
  hasCredentials: boolean
  senderName: string | null
  senderPhone: string | null
  originAddress: Record<string, string | null> | null
}

export async function fetchCourierAccounts(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<CourierAccount[]> {
  const { data, error } = await client
    .from('courier_accounts_safe')
    .select(
      `id, courier, account_ref, is_live, is_enabled, connected_at,
       has_credentials, sender_name, sender_phone, origin_address`,
    )
    .eq('tenant_id', tenantId)
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id ?? '',
    courier: (row.courier ?? 'jnt') as CourierId,
    accountRef: row.account_ref,
    isLive: row.is_live ?? false,
    isEnabled: row.is_enabled ?? false,
    connectedAt: row.connected_at,
    hasCredentials: row.has_credentials ?? false,
    senderName: row.sender_name,
    senderPhone: row.sender_phone,
    originAddress: row.origin_address as Record<string, string | null> | null,
  }))
}

/** The bits a seller may set directly. Credentials are not among them. */
export async function saveCourierProfile(
  input: {
    tenantId: string
    courier: CourierId
    senderName: string
    senderPhone: string
    originAddress: Record<string, string | null>
    accountRef: string
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const row = {
    sender_name: input.senderName,
    sender_phone: input.senderPhone,
    origin_address: input.originAddress,
    account_ref: input.accountRef,
    connected_at: new Date().toISOString(),
  }
  const existing = await client
    .from('courier_accounts')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('courier', input.courier)
    .maybeSingle()

  const { error } =
    existing.data === null
      ? await client
          .from('courier_accounts')
          .insert({ tenant_id: input.tenantId, courier: input.courier, ...row })
      : await client.from('courier_accounts').update(row).eq('id', existing.data.id)
  if (error) throw error
}

export async function setCourierEnabled(
  input: { accountId: string; isEnabled: boolean },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client
    .from('courier_accounts')
    .update({ is_enabled: input.isEnabled })
    .eq('id', input.accountId)
  if (error) throw error
}

async function accessToken(client: SelldClient): Promise<string> {
  const { data } = await client.auth.getSession()
  return data.session?.access_token ?? ''
}

export interface BookResult {
  booked: number
  failed: number
  alreadyBooked: number
  failures?: { orderNumber: string; reason: string }[]
}

/**
 * Book a batch through the server.
 *
 * The token goes in the Authorization header and the server passes it to PostgREST
 * unchanged, so `courier_booking_batch` runs as this seller and its
 * `has_tenant_role(..., 'packer')` check is the real gate. The server never decides
 * on its own whether the caller may book.
 */
export async function bookShipments(
  input: { tenantId: string; orderIds: string[]; courier: CourierId; service?: string },
  client: SelldClient = getSupabase(),
): Promise<BookResult> {
  const response = await fetch('/api/couriers/book', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken(client)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tenantId: input.tenantId,
      orderIds: input.orderIds,
      courier: input.courier,
      service: input.service ?? 'standard',
    }),
  })
  const body = (await response.json()) as BookResult & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `book failed with ${response.status}`)
  return body
}

/**
 * Download one PDF of all the labels for a batch.
 *
 * A blob URL rather than navigating: the endpoint is a POST carrying a bearer
 * token, which a plain `<a href>` cannot send.
 */
export async function downloadLabels(
  input: { tenantId: string; orderIds: string[] },
  client: SelldClient = getSupabase(),
): Promise<{ missing: number }> {
  const response = await fetch('/api/couriers/labels', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken(client)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tenantId: input.tenantId, orderIds: input.orderIds }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `labels failed with ${response.status}`)
  }

  const missing = Number(response.headers.get('X-Labels-Missing') ?? '0')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `labels-${input.orderIds.length}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { missing }
}

export function describeCourierError(error: unknown): string {
  const message = errorMessage(error).toLowerCase()
  if (message === '') return 'unknown'
  if (message.includes('courier_not_connected')) return 'not_connected'
  if (message.includes('no_encryption_key')) return 'server_misconfigured'
  if (message.includes('not_configured')) return 'server_misconfigured'
  if (message.includes('batch_too_large')) return 'batch_too_large'
  if (message.includes('no_labels')) return 'no_labels'
  if (message.includes('not_allowed') || message.includes('403')) return 'not_allowed'
  if (message.includes('unauthenticated') || message.includes('401')) return 'not_allowed'
  return 'unknown'
}
