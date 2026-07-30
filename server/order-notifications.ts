import { idempotencyKey } from '../src/core/integration/idempotency'
import { withRetry } from '../src/core/integration/retry'
import { createLogSmsProvider } from '../src/core/sms/log-provider'
import { smsRegistry } from '../src/core/sms/index'
import type { SmsProvider } from '../src/core/sms/types'
import { formatPHP } from '../src/lib/money'
import { fromDb } from '../src/lib/money/centavos'
import type { OrderReceipt } from '../src/storefront/cart-data'
import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Order confirmation SMS.
 *
 * Per hard rule 7 this goes through `src/core/sms` with an idempotency key, retry
 * with exponential backoff, and a row in `integration_logs`. The provider comes
 * from the registry rather than being imported directly, so phase 11 swaps
 * Semaphore in by registering it at startup and nothing here changes.
 *
 * The one behaviour that matters most: **this can never fail an order.** The order
 * is already committed, the stock is already reserved, and the buyer is already
 * looking at their confirmation page. A gateway outage must not turn that into an
 * error — so every failure is caught, logged, and swallowed. A missing SMS is a
 * problem the seller can work around by messaging the buyer; a failed checkout is
 * a lost sale.
 */

let registered = false

/**
 * Register the SMS provider.
 *
 * At startup, never at import time — the project convention exists so tests can
 * install a fake, and a module-level side effect would make that impossible.
 */
export function registerSmsProviders(provider?: SmsProvider): void {
  if (registered) return
  smsRegistry.register(provider ?? createLogSmsProvider())
  registered = true
}

/**
 * The message a buyer actually receives. Taglish, because the buyer is Filipino.
 *
 * Two cost decisions are baked in, and both were measured rather than assumed:
 *
 * 1. **`PHP` and not `₱`.** The peso sign is not in the GSM-7 alphabet, so a single
 *    `₱` forces the entire message to UCS-2 — which drops the per-segment budget
 *    from 160 characters to 70 and turned this 122-character message into two
 *    segments. One character was doubling the SMS bill on every order a seller
 *    took. "PHP 229.00" is also how Filipino sellers commonly write it.
 * 2. **Short.** Store name, order number, amount due, and what happens next.
 *    Anything more belongs on the confirmation page, which is free.
 */
export function orderConfirmedMessage(receipt: OrderReceipt): string {
  const total = formatPHP(fromDb(receipt.grandTotal), { symbol: false })
  return (
    `Salamat sa order mo sa ${receipt.store.name}! ` +
    `Order #${receipt.orderNumber}, PHP ${total} cash on delivery. ` +
    `Ite-text namin ang tracking kapag na-ship na.`
  )
}

export interface NotifyResult {
  attempted: boolean
  sent: boolean
  reason?: string
}

/**
 * Send the confirmation, then record it.
 *
 * Recording happens through `record_order_sms`, authorised by the same cart token
 * that produced the order — the server holds only the anon key, and a
 * service-role key would be a much wider grant than "write one log row for an
 * order this caller demonstrably owns".
 */
export async function notifyOrderPlaced(
  supabase: SupabaseConfig,
  token: string,
  receipt: OrderReceipt,
): Promise<NotifyResult> {
  registerSmsProviders()

  // Landlines cannot receive SMS. Attempting the send would burn a retry cycle and
  // record a failure for something that was never possible.
  if (!/^\+639\d{9}$/.test(receipt.contactPhone)) {
    return { attempted: false, sent: false, reason: 'not_mobile' }
  }

  const provider = smsRegistry.get('log')
  if (provider === undefined) return { attempted: false, sent: false, reason: 'no_provider' }

  const body = orderConfirmedMessage(receipt)
  const key = idempotencyKey({
    tenantId: receipt.store.slug,
    operation: 'sms.order_confirmed',
    entityId: receipt.id,
  })

  try {
    const result = await withRetry(
      () =>
        provider.send({
          to: receipt.contactPhone,
          body,
          purpose: 'tracking',
          idempotencyKey: key,
        }),
      { attempts: 3 },
    )

    const recorded = await rpc<boolean>(supabase, 'record_order_sms', {
      p_token: token,
      p_body: body,
      p_provider: result.provider,
      p_provider_ref: result.providerRef,
      p_status: result.status,
      p_cost_centavos: result.cost,
      p_segments: result.segments,
      p_idempotency_key: key,
    })

    return { attempted: true, sent: recorded }
  } catch (error) {
    // Logged, not raised. See the note at the top of this file.
    console.error('[storefront] order confirmation SMS failed', error)
    return {
      attempted: true,
      sent: false,
      reason: error instanceof Error ? error.message : 'unknown',
    }
  }
}
