import { idempotencyKey } from '@/core/integration/idempotency'
import { IntegrationError } from '@/core/integration/errors'
import { withRetry } from '@/core/integration/retry'
import { XenditProvider } from '@/core/payments/xendit-provider'
import type { Centavos } from '@/lib/money'

import { rpc, type SupabaseConfig } from './supabase-rpc'
import { readServiceConfig } from './payment-webhook'

/**
 * Opening an online payment for a freshly placed order.
 *
 * Runs on the same request as checkout, between the order being written and the
 * buyer being redirected. Three things about that shape are deliberate:
 *
 * 1. **The `payments` row is created before the provider is called.** A crash or a
 *    timeout between the two then leaves a visible `pending` payment rather than an
 *    order that silently has no payment attached and no way for anyone to tell
 *    whether the buyer was charged.
 *
 * 2. **The amount comes from the order, never from the form.** `payment_open_for_token`
 *    reads `orders.grand_total_centavos` server-side and returns it; nothing the
 *    browser posted reaches the invoice. That is hard rule 6 applied on the way out
 *    rather than only at pricing time.
 *
 * 3. **The idempotency key is derived from the order, not generated.** A retry after
 *    a timeout has to be recognised by Xendit as the *same* request, or a buyer who
 *    hit a slow network gets two invoices for one order. `idempotencyKey()` is
 *    deterministic across process restarts for exactly this reason.
 *
 * Every call is retried with backoff and logged to `integration_logs`, per hard
 * rule 7.
 */

export interface StartedPayment {
  paymentId: string
  checkoutUrl: string
}

interface OpenedPayment {
  paymentId: string
  orderId: string
  orderNumber: string
  amount: number
  method: string
  contactName: string
  contactPhone: string
  contactEmail: string | null
}

/** Credentials behind a payment. Service role: these are never client-readable. */
async function readCredentials(
  service: SupabaseConfig,
  paymentId: string,
): Promise<{ tenantId: string; secretKey: string; callbackToken: string } | null> {
  const rows = await rpc<
    { tenant_id: string; secret_key: string | null; callback_token: string | null }[]
  >(service, 'payment_credentials_for_payment', { p_payment_id: paymentId })
  const row = rows[0]
  if (row?.secret_key == null || row.callback_token == null) return null
  return {
    tenantId: row.tenant_id,
    secretKey: row.secret_key,
    callbackToken: row.callback_token,
  }
}

/**
 * Write an `integration_logs` row for one attempt.
 *
 * Never allowed to fail the payment: an observability gap is bad, and losing a
 * buyer's checkout because the log table was busy is worse.
 */
async function logAttempt(
  service: SupabaseConfig,
  entry: {
    tenantId: string
    operation: string
    idempotencyKey: string
    status: 'success' | 'failed'
    attempt: number
    durationMs: number
    errorCode?: string
    errorMessage?: string
  },
): Promise<void> {
  try {
    await rpc(service, 'log_integration_attempt', {
      p_tenant_id: entry.tenantId,
      p_provider: 'xendit',
      p_operation: entry.operation,
      p_idempotency_key: entry.idempotencyKey,
      p_status: entry.status,
      p_attempt: entry.attempt,
      p_error_code: entry.errorCode ?? null,
      p_error_message: entry.errorMessage ?? null,
      p_duration_ms: entry.durationMs,
    })
  } catch {
    // Deliberately swallowed. See the note above.
  }
}

export async function startOnlinePayment(input: {
  supabase: SupabaseConfig
  cartToken: string
  orderId: string
  method: string
  origin: string
}): Promise<StartedPayment | null> {
  const service = readServiceConfig()
  if (service === null) return null

  // The order is the source of truth for the amount and the contact details.
  const opened = await rpc<OpenedPayment>(input.supabase, 'payment_open_for_token', {
    p_token: input.cartToken,
    p_order_id: input.orderId,
    p_method: input.method,
  })

  const credentials = await readCredentials(service, opened.paymentId)
  if (credentials === null) return null

  const provider = new XenditProvider(credentials)
  const tenantId = credentials.tenantId
  const key = idempotencyKey({
    tenantId,
    operation: 'payment.charge',
    entityId: opened.paymentId,
  })

  const startedAt = Date.now()
  let attempts = 0

  try {
    const charge = await withRetry(
      async (attempt) => {
        attempts = attempt
        return provider.createCharge({
          reference: opened.orderNumber,
          amount: opened.amount as Centavos,
          method: input.method as 'gcash',
          customerName: opened.contactName,
          customerPhone: opened.contactPhone,
          ...(opened.contactEmail === null ? {} : { customerEmail: opened.contactEmail }),
          successUrl: `${input.origin}/order/confirmed`,
          failureUrl: `${input.origin}/order/confirmed?payment=failed`,
          // 24 hours. Long enough for a buyer to finish on another device, short
          // enough that reserved stock is not held for a week.
          expiresInSeconds: 86_400,
          idempotencyKey: key,
        })
      },
      { attempts: 3 },
    )

    await rpc(service, 'attach_payment_charge', {
      p_payment_id: opened.paymentId,
      p_provider_ref: charge.providerRef,
      p_checkout_url: charge.checkoutUrl ?? null,
      p_status: charge.status,
      p_expires_at: charge.expiresAt?.toISOString() ?? null,
      p_raw: null,
    })

    await logAttempt(service, {
      tenantId,
      operation: 'payment.charge',
      idempotencyKey: key,
      status: 'success',
      attempt: attempts,
      durationMs: Date.now() - startedAt,
    })

    if (charge.checkoutUrl === undefined) return null
    return { paymentId: opened.paymentId, checkoutUrl: charge.checkoutUrl }
  } catch (error) {
    await logAttempt(service, {
      tenantId,
      operation: 'payment.charge',
      idempotencyKey: key,
      status: 'failed',
      attempt: attempts,
      durationMs: Date.now() - startedAt,
      ...(error instanceof IntegrationError
        ? { errorCode: error.kind, errorMessage: error.message.slice(0, 500) }
        : { errorMessage: String(error).slice(0, 500) }),
    })
    // The order exists and the payment row is `pending`. The buyer lands on the
    // confirmation page, which offers to try the payment again — losing the order
    // because the provider had a bad minute would be worse than either.
    return null
  }
}
