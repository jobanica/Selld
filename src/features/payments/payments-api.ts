import { fromDb, type Centavos } from '@/lib/money'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Payments, seller side.
 *
 * The shape to notice here is what is *absent*: nothing in this file can read a
 * secret key or a callback token. `payment_accounts` has no SELECT grant on those
 * columns, so a query for them fails rather than returning null — the client
 * literally cannot fetch them, whatever it asks for. Reads go through
 * `payment_accounts_safe`, which reports whether a key is set and its last four
 * characters, and nothing more.
 *
 * Writes are a different matter: a seller has to be able to *set* a key. Insert and
 * update are granted, so the credentials can go in and never come back out.
 */

export type PaymentMethod = 'cod' | 'gcash' | 'maya' | 'grabpay' | 'card' | 'bank' | 'qrph'
export type PaymentStatus =
  | 'pending'
  | 'awaiting_action'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'partially_refunded'

export interface PaymentAccount {
  id: string
  provider: 'xendit'
  isLive: boolean
  isEnabled: boolean
  connectedAt: string | null
  hasSecretKey: boolean
  hasCallbackToken: boolean
  secretKeyLast4: string | null
  /** The path segment the provider posts to. Not a secret, but unguessable. */
  webhookSlug: string | null
}

export interface Payment {
  id: string
  orderId: string
  provider: 'xendit' | 'cod' | 'manual'
  method: PaymentMethod
  status: PaymentStatus
  amount: Centavos
  fee: Centavos | null
  refunded: Centavos
  providerRef: string | null
  proofPath: string | null
  proofNote: string | null
  paidAt: string | null
  createdAt: string
}

/**
 * The account, or null when the seller has not started connecting one.
 *
 * Two queries rather than one because the safe view deliberately omits
 * `webhook_slug` — the view exists to answer "is my key set?", and the slug is a
 * routing value the seller needs to paste into Xendit. Keeping them separate means
 * the view can never accidentally grow a secret column.
 */
export async function fetchPaymentAccount(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<PaymentAccount | null> {
  const [safe, routing] = await Promise.all([
    client
      .from('payment_accounts_safe')
      .select('id, provider, is_live, is_enabled, connected_at, has_secret_key, has_callback_token, secret_key_last4')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    client
      .from('payment_accounts')
      .select('webhook_slug')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ])

  if (safe.error) throw safe.error
  if (safe.data === null) return null

  return {
    id: safe.data.id ?? '',
    provider: 'xendit',
    isLive: safe.data.is_live ?? false,
    isEnabled: safe.data.is_enabled ?? false,
    connectedAt: safe.data.connected_at,
    hasSecretKey: safe.data.has_secret_key ?? false,
    hasCallbackToken: safe.data.has_callback_token ?? false,
    secretKeyLast4: safe.data.secret_key_last4,
    webhookSlug: routing.data?.webhook_slug ?? null,
  }
}

/**
 * Save credentials.
 *
 * A blank field means "leave what is there", not "clear it" — a seller re-saving to
 * flip the live/test switch must not silently wipe a key they cannot see and would
 * have to fetch from Xendit again.
 */
export async function savePaymentAccount(
  input: {
    tenantId: string
    secretKey: string
    callbackToken: string
    isLive: boolean
    isEnabled: boolean
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const existing = await client
    .from('payment_accounts')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .maybeSingle()

  const row = {
    is_live: input.isLive,
    is_enabled: input.isEnabled,
    connected_at: new Date().toISOString(),
    ...(input.secretKey.trim() === '' ? {} : { secret_key: input.secretKey.trim() }),
    ...(input.callbackToken.trim() === '' ? {} : { callback_token: input.callbackToken.trim() }),
  }

  const { error } =
    existing.data === null
      ? await client
          .from('payment_accounts')
          .insert({ tenant_id: input.tenantId, provider: 'xendit', ...row })
      : await client.from('payment_accounts').update(row).eq('id', existing.data.id)

  if (error) throw error
}

export async function fetchPaymentsForOrder(
  orderId: string,
  client: SelldClient = getSupabase(),
): Promise<Payment[]> {
  const { data, error } = await client
    .from('payments')
    // One string literal, not a concatenation: PostgREST's types read the select
    // list as a literal type to infer the row shape, and `'a, ' + 'b'` widens to
    // `string`, which silently degrades every field below to an error type.
    .select(
      `id, order_id, provider, method, status, amount_centavos, fee_centavos,
       refunded_centavos, provider_ref, proof_path, proof_note, paid_at, created_at`,
    )
    .eq('order_id', orderId)
    .order('created_at')

  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    provider: row.provider as Payment['provider'],
    method: row.method as PaymentMethod,
    status: row.status as PaymentStatus,
    amount: fromDb(row.amount_centavos),
    fee: row.fee_centavos === null ? null : fromDb(row.fee_centavos),
    refunded: fromDb(row.refunded_centavos),
    providerRef: row.provider_ref,
    proofPath: row.proof_path,
    proofNote: row.proof_note,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  }))
}

/**
 * Record a payment that arrived outside any provider.
 *
 * How most PH social sellers are actually paid today, so it is a first-class path.
 * `proofPath` points into the **private** bucket — a GCash receipt carries a
 * buyer's name, the amount and a reference number, and the public bucket would make
 * each one readable by URL alone.
 */
export async function recordManualPayment(
  input: {
    orderId: string
    method: Exclude<PaymentMethod, 'cod'>
    amount: Centavos
    proofPath?: string
    note?: string
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('record_manual_payment', {
    p_order_id: input.orderId,
    p_method: input.method,
    p_amount: input.amount,
    // Omitted rather than passed as null: the generated signatures model an
    // optional Postgres argument as optional, not as nullable.
    ...(input.proofPath === undefined ? {} : { p_proof_path: input.proofPath }),
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

/** COD collected by the rider and remitted by the courier. */
export async function recordCodRemittance(
  input: { orderId: string; amount?: Centavos; note?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('record_cod_remittance', {
    p_order_id: input.orderId,
    ...(input.amount === undefined ? {} : { p_amount: input.amount }),
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

/**
 * Refund, in two steps.
 *
 * `open_refund` records the intent, `settle_refund` confirms it. Split because a
 * provider answers asynchronously, and because a refund the seller sent by hand
 * settles with no provider involved — recording first means a refund that fails at
 * the provider is visible as `pending` rather than lost.
 */
export async function openRefund(
  input: { paymentId: string; amount: Centavos; reason: string },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client.rpc('open_refund', {
    p_payment_id: input.paymentId,
    p_amount: input.amount,
    p_reason: input.reason,
  })
  if (error) throw error
  return ((data ?? {}) as { refundId?: string }).refundId ?? ''
}

export async function settleRefund(
  input: { refundId: string; status: 'succeeded' | 'failed'; providerRef?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('settle_refund', {
    p_refund_id: input.refundId,
    p_status: input.status,
    ...(input.providerRef === undefined ? {} : { p_provider_ref: input.providerRef }),
  })
  if (error) throw error
}

/**
 * Turn a write failure into something a seller can act on.
 *
 * `errorMessage`, not `error instanceof Error` — PostgREST returns a plain object on
 * the ordinary path, and an instanceof guard here would send every one of these to
 * `unknown`. See src/lib/supabase/errors.ts; this shipped twice before.
 */
export function describePaymentError(error: unknown): string {
  const message = errorMessage(error).toLowerCase()
  if (message === '') return 'unknown'
  if (message.includes('payment_accounts_enabled_needs_credentials')) return 'needs_credentials'
  if (message.includes('over_refund')) return 'over_refund'
  if (message.includes('not_settled')) return 'not_settled'
  if (message.includes('not_cod')) return 'not_cod'
  if (message.includes('already_paid')) return 'already_paid'
  if (message.includes('permission') || message.includes('not allowed')) return 'not_allowed'
  return 'unknown'
}

/**
 * The URL a seller pastes into Xendit's dashboard.
 *
 * Built from the slug rather than from a tenant id, so the value on screen — and in
 * every support screenshot of this page — names nothing.
 */
export function webhookUrl(slug: string | null, origin: string): string | null {
  if (slug === null || slug === '') return null
  return `${origin}/api/webhooks/xendit/${slug}`
}
