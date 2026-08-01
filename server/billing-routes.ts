import type { IncomingMessage, ServerResponse } from 'node:http'

import { IntegrationError, withRetry, idempotencyKey } from '@/core/integration'
import { centavos } from '@/lib/money'
import {
  fromXenditAmount,
  safeEqual,
  toXenditAmount,
} from '@/core/payments/xendit-provider'

import { readServiceConfig } from './payment-webhook'
import { rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * Platform billing: raising Selld's own invoices, and hearing back about them.
 *
 * ## Why this is not `src/core/payments`
 *
 * `src/core` is the extraction boundary — it becomes `@yourorg/ph-commerce-core`,
 * a library about selling in the Philippines. *Selld charging a seller rent* is
 * not that. It is this company's own commercial arrangement, so it lives in the
 * server, and the only things it borrows from core are the pieces that are about
 * Xendit rather than about us: the peso conversion, the constant-time compare,
 * the retry curve.
 *
 * ## Whose money moves
 *
 * A seller's *buyers* pay the seller, through the seller's own Xendit account —
 * that is phase 8, and none of it is here. A seller pays *Selld* through Selld's
 * platform account, which is the key in this file's environment and nowhere else.
 * When a reseller is in the middle, Selld still collects and
 * `subscription_invoices.platform_cut_centavos` records what Selld keeps; the
 * remainder is what `reseller_revenue_split()` reports the reseller is owed.
 *
 * Collecting centrally rather than handing each reseller their own gateway keys is
 * the difference between one secret and one per partner, and it is what lets a
 * reseller onboard a seller with nobody at Selld involved: there is no key to
 * issue, so there is no step to wait on.
 *
 * ## The loop is here and the rules are not
 *
 * Same split as phase 16's broadcast sender and phase 17's stock push, for the
 * same reason: Postgres cannot call Xendit. `billing_due_claim` decides what is
 * owed and writes the invoice row *before* returning it; `billing_invoice_settle`
 * decides what a payment or a failure does to the subscription. This file calls an
 * HTTP API and hands back the answer.
 */

/**
 * Overridable so an end-to-end run can point the biller at a fake gateway.
 *
 * The same reason the marketplace providers take a base URL: a proof that stops
 * short of the network call is a proof of everything except the part that spends
 * money. Never set in production — the default is the only address that exists.
 */
const XENDIT_API = (process.env.PLATFORM_XENDIT_API_BASE ?? 'https://api.xendit.co').replace(
  /\/+$/,
  '',
)

/** How often the biller looks for subscriptions past their period end. */
export const BILLING_POLL_MS = 5 * 60_000

/** How often the clock runs: trials ending, grace expiring, cancellations. */
export const DUNNING_POLL_MS = 15 * 60_000

export const BILLING_WEBHOOK_PATH = '/api/webhooks/billing'

/** A billing callback is small. Anything larger is not Xendit. */
const MAX_BODY_BYTES = 64 * 1024

export interface PlatformBillingConfig {
  secretKey: string
  callbackToken: string
  /** Where a seller lands after paying. */
  returnUrl: string
  fetchImpl?: typeof fetch
}

/**
 * Selld's own gateway credentials.
 *
 * Never `VITE_`-prefixed: a `VITE_` variable is compiled into the public bundle,
 * and this key can charge cards. Absent config disables billing rather than
 * failing the process — a developer running the storefront should not need
 * Selld's production billing key to look at a product page.
 */
export function readPlatformBillingConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformBillingConfig | null {
  const secretKey = env.PLATFORM_XENDIT_SECRET_KEY
  const callbackToken = env.PLATFORM_XENDIT_CALLBACK_TOKEN
  if (secretKey === undefined || callbackToken === undefined) return null
  if (secretKey.trim() === '' || callbackToken.trim() === '') return null
  return {
    secretKey: secretKey.trim(),
    callbackToken: callbackToken.trim(),
    returnUrl: (env.PLATFORM_BILLING_RETURN_URL ?? 'https://app.selld.ph/settings/billing').trim(),
  }
}

interface XenditInvoice {
  id: string
  status: string
  invoice_url: string
  amount: number
}

/**
 * Raise a hosted invoice on the platform account.
 *
 * `external_id` is our own row id, so a support conversation with Xendit and a
 * support conversation with a seller are about the same string. The idempotency
 * key is derived from the invoice row rather than generated, per hard rule 7 and
 * for the reason that rule exists: a retry after a timeout must return the
 * invoice we already raised, not raise a second one against the same month.
 */
async function createPlatformInvoice(
  config: PlatformBillingConfig,
  input: {
    externalId: string
    amountCentavos: number
    description: string
    payerEmail?: string
    idempotencyKey: string
  },
): Promise<XenditInvoice> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch

  return withRetry(async () => {
    const response = await fetchImpl(`${XENDIT_API}/v2/invoices`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${config.secretKey}:`)}`,
        'Content-Type': 'application/json',
        'X-IDEMPOTENCY-KEY': input.idempotencyKey,
      },
      body: JSON.stringify({
        external_id: input.externalId,
        amount: toXenditAmount(centavos(input.amountCentavos)),
        currency: 'PHP',
        description: input.description,
        success_redirect_url: config.returnUrl,
        failure_redirect_url: config.returnUrl,
        ...(input.payerEmail === undefined ? {} : { payer_email: input.payerEmail }),
      }),
    })

    const text = await response.text()
    if (!response.ok) {
      // 4xx is our mistake and will be our mistake again on the fourth attempt;
      // 5xx and 429 are worth the backoff curve.
      throw new IntegrationError(
        response.status >= 500 || response.status === 429 ? 'transient' : 'permanent',
        `Xendit invoice failed with ${String(response.status)}: ${text.slice(0, 300)}`,
        { provider: 'xendit', endpoint: '/v2/invoices' },
      )
    }
    return JSON.parse(text) as XenditInvoice
  })
}

interface DueInvoice {
  invoiceId: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  amountCentavos: number
  platformCutCentavos: number
  billedBy: string | null
  periodStart: string
  periodEnd: string
}

/**
 * One pass of the biller.
 *
 * Claim first, then call. A worker that died between the two leaves an invoice
 * row with no `xendit_invoice_id`, which the next pass picks up because
 * `billing_due_claim` skips a period that already has an open row — so the
 * failure mode is a late invoice, never a double charge.
 */
export async function runBillingCycle(
  service: SupabaseConfig,
  config: PlatformBillingConfig,
): Promise<number> {
  const due = await rpc<DueInvoice[] | null>(service, 'billing_due_claim', { p_limit: 20 })
  if (due === null || due.length === 0) return 0

  let raised = 0
  for (const invoice of due) {
    try {
      const created = await createPlatformInvoice(config, {
        externalId: invoice.invoiceId,
        amountCentavos: invoice.amountCentavos,
        description:
          invoice.billedBy === null
            ? `Selld subscription — ${invoice.tenantName}`
            : `${invoice.billedBy} — ${invoice.tenantName}`,
        idempotencyKey: idempotencyKey({
          tenantId: invoice.tenantId,
          operation: 'billing.invoice',
          entityId: invoice.invoiceId,
        }),
      })

      await rpc(service, 'billing_invoice_attach', {
        p_invoice_id: invoice.invoiceId,
        p_external_id: created.id,
        p_checkout_url: created.invoice_url,
      })
      raised += 1
    } catch (error) {
      // The row stays open with its attempt counted, and `billing_due_claim`
      // re-emits it next pass. Nothing is charged and nothing is lost, which is
      // the correct shape for money: a missed collection is recoverable and a
      // double one is not.
      //
      // Note what this is *not*: marking the invoice `failed`. That is the word
      // for "the seller's payment did not go through", and it starts the dunning
      // clock. Our own inability to reach Xendit must never put a store into
      // `past_due`.
      await rpc(service, 'billing_invoice_note_failure', {
        p_invoice_id: invoice.invoiceId,
        p_error: String(error).slice(0, 400),
      }).catch(() => {})
    }
  }
  return raised
}

/** Start a credit-pack checkout for a seller who has just pressed buy. */
export async function startCreditCheckout(
  service: SupabaseConfig,
  config: PlatformBillingConfig,
  input: { tenantId: string; purchaseId: string; credits: number; amountCentavos: number },
): Promise<string> {
  const created = await createPlatformInvoice(config, {
    externalId: input.purchaseId,
    amountCentavos: input.amountCentavos,
    description: `${String(input.credits)} SMS credits`,
    idempotencyKey: idempotencyKey({
      tenantId: input.tenantId,
      operation: 'billing.credits',
      entityId: input.purchaseId,
    }),
  })

  await rpc(service, 'credit_purchase_attach', {
    p_purchase_id: input.purchaseId,
    p_external_id: created.id,
    p_checkout_url: created.invoice_url,
  })
  return created.invoice_url
}

/**
 * The clock. Runs whether or not anything is due.
 *
 * Separate from the biller because the two fail differently: the biller needs
 * Xendit to be up and this needs nothing at all, so a gateway outage must not
 * also stop a cancellation from taking effect on the day the seller asked for.
 */
export async function runDunning(service: SupabaseConfig): Promise<void> {
  await rpc(service, 'billing_dunning_run', {})
}

export function startBillingWorker(
  service: SupabaseConfig,
  config: PlatformBillingConfig,
  options: { billingIntervalMs?: number; dunningIntervalMs?: number } = {},
): () => void {
  let billing = false
  let dunning = false

  const bill = setInterval(() => {
    if (billing) return
    billing = true
    void runBillingCycle(service, config)
      .catch(() => {})
      .finally(() => {
        billing = false
      })
  }, options.billingIntervalMs ?? BILLING_POLL_MS)

  const dun = setInterval(() => {
    if (dunning) return
    dunning = true
    void runDunning(service)
      .catch(() => {})
      .finally(() => {
        dunning = false
      })
  }, options.dunningIntervalMs ?? DUNNING_POLL_MS)

  bill.unref?.()
  dun.unref?.()

  return () => {
    clearInterval(bill)
    clearInterval(dun)
  }
}

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------
async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Webhook body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

/** Xendit invoice status -> what it means for a bill. */
function billingStatus(status: string): 'paid' | 'failed' | 'void' | null {
  const upper = status.toUpperCase()
  if (upper === 'PAID' || upper === 'SETTLED') return 'paid'
  if (upper === 'EXPIRED' || upper === 'FAILED') return 'failed'
  if (upper === 'VOID' || upper === 'VOIDED') return 'void'
  return null
}

/**
 * `POST /api/webhooks/billing`
 *
 * One path for both kinds of platform invoice — subscriptions and credit packs —
 * because Xendit does not tell us which is which and we should not guess from the
 * amount. Both settle functions are keyed on `xendit_invoice_id` and both return
 * `false` for a row they do not own, so trying each in turn is exact rather than
 * heuristic.
 *
 * The token is verified before anything is dispatched, in constant time. Reversing
 * that order makes this a "mark any subscription paid" endpoint for anyone who can
 * guess an invoice id, which is the same trap phase 8 documents on the payment
 * webhook.
 *
 * A body we cannot match answers 200. Xendit retries any non-2xx, and a delivery
 * that does not match will not start matching on the fourth attempt.
 */
export async function serveBillingWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (pathname !== BILLING_WEBHOOK_PATH) return false
  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const config = readPlatformBillingConfig(env)
  const service = readServiceConfig(env)
  if (config === null || service === null) {
    send(response, 503, { error: 'billing_not_configured' })
    return true
  }

  const token = String(request.headers['x-callback-token'] ?? '')
  if (!safeEqual(token, config.callbackToken)) {
    send(response, 401, { error: 'bad_token' })
    return true
  }

  let payload: { id?: string; status?: string; paid_at?: string; amount?: number }
  try {
    payload = JSON.parse(await readRawBody(request)) as typeof payload
  } catch {
    send(response, 200, { ok: true, ignored: 'unparseable' })
    return true
  }

  const externalId = payload.id ?? ''
  const status = billingStatus(payload.status ?? '')
  if (externalId === '' || status === null) {
    send(response, 200, { ok: true, ignored: 'unknown_event' })
    return true
  }

  const paidAt = payload.paid_at ?? null

  try {
    const applied = await rpc<boolean>(service, 'billing_invoice_settle', {
      p_external_id: externalId,
      p_status: status,
      p_paid_at: paidAt,
      p_error: null,
    })
    if (applied) {
      send(response, 200, { ok: true, kind: 'subscription' })
      return true
    }

    const credited = await rpc<boolean>(service, 'credit_purchase_settle', {
      p_external_id: externalId,
      p_status: status,
      p_paid_at: paidAt,
    })
    send(response, 200, { ok: true, kind: credited ? 'credits' : 'noop' })
  } catch {
    // Our database, not their delivery. This one is worth retrying.
    send(response, 503, { error: 'unavailable' })
  }
  return true
}

// ---------------------------------------------------------------------------
// The dashboard's one server-held action
// ---------------------------------------------------------------------------
const CREDIT_CHECKOUT_PATH = /^\/api\/billing\/([0-9a-f-]{36})\/credits$/i

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/**
 * `POST /api/billing/{tenantId}/credits`
 *
 * The seller's token does the authorising, not this file: `credit_purchase_start`
 * checks `admin` on the tenant itself and computes the price from the platform's
 * own pack table. All this route adds is the half the browser cannot do — Selld's
 * gateway key, which must never reach a client.
 */
export async function serveBillingRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const match = CREDIT_CHECKOUT_PATH.exec(url.pathname)
  if (match === null) return false
  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const tenantId = match[1] ?? ''
  const config = readPlatformBillingConfig(env)
  const service = readServiceConfig(env)
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY
  if (config === null || service === null || supabaseUrl === undefined || anonKey === undefined) {
    send(response, 503, { error: 'billing_not_configured' })
    return true
  }

  const accessToken = bearer(request)
  if (accessToken === '') {
    send(response, 401, { error: 'unauthenticated' })
    return true
  }

  let body: { credits?: number }
  try {
    body = JSON.parse(await readRawBody(request)) as typeof body
  } catch {
    send(response, 400, { error: 'bad_request' })
    return true
  }

  try {
    // Called with the seller's own token — `apikey` stays the anon key, the
    // bearer is the caller — so `credit_purchase_start` sees the real user and
    // its `has_tenant_role` check is the check. Using the service role here
    // would make this route the authorisation, which is a second copy of a rule
    // the database already holds.
    const startResponse = await fetch(
      `${supabaseUrl.trim().replace(/\/+$/, '')}/rest/v1/rpc/credit_purchase_start`,
      {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_tenant_id: tenantId, p_credits: body.credits ?? 0 }),
      },
    )
    const startText = await startResponse.text()
    if (!startResponse.ok) {
      send(response, startResponse.status === 401 ? 401 : 403, {
        error: startText.slice(0, 300),
      })
      return true
    }
    const started = JSON.parse(startText) as {
      purchaseId: string
      credits: number
      amountCentavos: number
    }

    const checkoutUrl = await startCreditCheckout(service, config, {
      tenantId,
      purchaseId: started.purchaseId,
      credits: started.credits,
      amountCentavos: started.amountCentavos,
    })
    send(response, 200, { checkoutUrl, amountCentavos: started.amountCentavos })
  } catch (error) {
    send(response, 400, { error: String(error).slice(0, 300) })
  }
  return true
}

export { fromXenditAmount }
