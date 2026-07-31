import { centavos, type Centavos } from '@/lib/money'
import { IntegrationError } from '@/core/integration/errors'

import type {
  Charge,
  ChargeInput,
  PaymentEvent,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  Refund,
  RefundInput,
} from './types'

/**
 * Xendit, via the Invoices API.
 *
 * Invoices rather than per-channel charge APIs, deliberately. A single invoice
 * covers GCash, Maya, GrabPay, QRPH and cards behind one hosted page that Xendit
 * keeps current with the channels a Philippine buyer actually has — and it means
 * card details never touch this codebase, so PCI scope stays at SAQ-A. The cost is
 * a redirect off the storefront, which is the normal shape for e-wallet payments
 * here anyway: GCash bounces the buyer to its own app regardless.
 *
 * ## Amounts
 *
 * Xendit's `amount` for PHP is in **pesos**, not centavos. Everything inside Selld
 * is integer centavos (hard rule 2), so the conversion happens here and nowhere
 * else — and it is the reason `toXenditAmount` refuses a value that is not a whole
 * number of centavos rather than rounding it. A rounded amount is an invoice that
 * disagrees with the order by a centavo, and a payment that then fails the
 * short-pay check for reasons no one can explain.
 *
 * ## What this file must not do
 *
 * `src/core` is the extraction boundary: no React, no imports from `app`,
 * `storefront` or `features`, and no direct database access. The provider is handed
 * its credentials and returns plain data; persisting any of it is the caller's job.
 */

const XENDIT_API = 'https://api.xendit.co'

/** Selld method -> Xendit `payment_methods` entry on an invoice. */
const METHOD_TO_CHANNEL: Record<Exclude<PaymentMethod, 'cod' | 'bank'>, string> = {
  gcash: 'GCASH',
  maya: 'PAYMAYA',
  grabpay: 'GRABPAY',
  qrph: 'QRPH',
  card: 'CREDIT_CARD',
}

/** Xendit invoice status -> our payment status. */
const INVOICE_STATUS: Record<string, PaymentStatus> = {
  PENDING: 'awaiting_action',
  PAID: 'paid',
  SETTLED: 'paid',
  EXPIRED: 'expired',
  FAILED: 'failed',
}

/**
 * Xendit's channel code on a paid invoice -> our method.
 *
 * Only used to record what the buyer actually chose on the hosted page, which can
 * differ from what they picked on our checkout screen.
 */
const CHANNEL_TO_METHOD: Record<string, PaymentMethod> = {
  GCASH: 'gcash',
  PAYMAYA: 'maya',
  GRABPAY: 'grabpay',
  QRPH: 'qrph',
  CREDIT_CARD: 'card',
  DEBIT_CARD: 'card',
}

export interface XenditConfig {
  /** The tenant's own secret key. Never a platform-wide one — the money is theirs. */
  secretKey: string
  /** Static per-account value Xendit echoes in `x-callback-token`. */
  callbackToken: string
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  /** Request timeout. Xendit is usually fast; a hung socket must not hold a checkout. */
  timeoutMs?: number
}

/**
 * Centavos -> the peso decimal Xendit expects.
 *
 * Refuses rather than rounds. See the note at the top of the file.
 */
export function toXenditAmount(amount: Centavos): number {
  if (!Number.isInteger(amount)) {
    throw new RangeError(`Amount must be whole centavos, got ${String(amount)}`)
  }
  return amount / 100
}

/**
 * Pesos back to centavos.
 *
 * `Math.round` here is not the rounding the function above refuses: this is
 * undoing a float division that JSON forced on us, so 1600.01 * 100 = 160000.99999
 * has to be corrected. Without it, an amount arrives one centavo light and a fully
 * paid order is recorded as a short-pay.
 */
export function fromXenditAmount(amount: number): Centavos {
  return centavos(Math.round(amount * 100))
}

/**
 * Constant-time string comparison.
 *
 * Verifying a callback token with `===` leaks its length and its matching prefix
 * through timing. That is a slow attack and a real one, and the token is the only
 * thing standing between an attacker and marking arbitrary orders paid. Written by
 * hand rather than with `crypto.timingSafeEqual` because `src/core` has to stay
 * runtime-agnostic — it is bundled for the browser as well as run under Node.
 */
export function safeEqual(a: string, b: string): boolean {
  // Length is compared separately and unavoidably leaks; the token is fixed-length
  // in practice, so this reveals nothing useful.
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}

function classify(status: number, body: string, endpoint: string): IntegrationError {
  const context = { provider: 'xendit', endpoint, statusCode: status }

  if (status === 401 || status === 403) {
    return new IntegrationError('auth', 'Xendit rejected the API key', context)
  }
  // 409 on an idempotent replay is a success we simply already had.
  if (status === 409) {
    return new IntegrationError('duplicate', 'Xendit has this request already', context)
  }
  if (status === 429 || status >= 500) {
    return new IntegrationError('transient', `Xendit returned ${status}`, context)
  }
  return new IntegrationError('permanent', `Xendit rejected the request: ${body.slice(0, 300)}`, context)
}

export class XenditProvider implements PaymentProvider {
  readonly id = 'xendit' as const
  readonly label = 'Xendit'
  readonly supportedMethods = ['gcash', 'maya', 'grabpay', 'qrph', 'card'] as const

  private readonly config: Required<Omit<XenditConfig, 'fetchImpl'>> & {
    fetchImpl: typeof fetch
  }

  constructor(config: XenditConfig) {
    if (config.secretKey === '') throw new Error('XenditProvider needs a secret key')
    this.config = {
      secretKey: config.secretKey,
      callbackToken: config.callbackToken,
      fetchImpl: config.fetchImpl ?? globalThis.fetch,
      timeoutMs: config.timeoutMs ?? 10_000,
    }
  }

  private authHeader(): string {
    // Xendit uses HTTP Basic with the secret key as the username and no password.
    // `btoa` rather than Buffer: core must not assume Node.
    return `Basic ${btoa(`${this.config.secretKey}:`)}`
  }

  private async call<T>(
    endpoint: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await this.config.fetchImpl(`${XENDIT_API}${endpoint}`, {
        method: init.method,
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/json',
          // Xendit honours this header on invoice creation, so a retry after a
          // timeout returns the original invoice instead of billing twice.
          ...(init.idempotencyKey === undefined
            ? {}
            : { 'X-IDEMPOTENCY-KEY': init.idempotencyKey }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      })

      const text = await response.text()
      if (!response.ok) throw classify(response.status, text, endpoint)

      return JSON.parse(text) as T
    } catch (error) {
      if (error instanceof IntegrationError) throw error
      // AbortError and network failures are both worth retrying.
      throw new IntegrationError('transient', `Xendit call failed: ${String(error)}`, {
        provider: 'xendit',
        endpoint,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async createCharge(input: ChargeInput): Promise<Charge> {
    if (input.method === 'cod' || input.method === 'bank') {
      throw new Error(`Xendit does not handle ${input.method}`)
    }

    const payload = {
      // Our order number, so it appears on the buyer's e-wallet statement and is
      // what a seller can search for when a buyer sends a screenshot.
      external_id: input.reference,
      amount: toXenditAmount(input.amount),
      currency: 'PHP',
      payer_email: input.customerEmail,
      description: `Order ${input.reference}`,
      success_redirect_url: input.successUrl,
      failure_redirect_url: input.failureUrl,
      // Restricting to the chosen channel keeps the hosted page one tap deep
      // instead of presenting the full menu again.
      payment_methods: [METHOD_TO_CHANNEL[input.method]],
      ...(input.expiresInSeconds === undefined
        ? {}
        : { invoice_duration: input.expiresInSeconds }),
      customer: {
        given_names: input.customerName,
        mobile_number: input.customerPhone,
        ...(input.customerEmail === undefined ? {} : { email: input.customerEmail }),
      },
    }

    const invoice = await this.call<{
      id: string
      status: string
      invoice_url: string
      amount: number
      expiry_date?: string
    }>('/v2/invoices', {
      method: 'POST',
      body: payload,
      idempotencyKey: input.idempotencyKey,
    })

    return {
      provider: 'xendit',
      providerRef: invoice.id,
      status: INVOICE_STATUS[invoice.status] ?? 'awaiting_action',
      checkoutUrl: invoice.invoice_url,
      amount: fromXenditAmount(invoice.amount),
      ...(invoice.expiry_date === undefined
        ? {}
        : { expiresAt: new Date(invoice.expiry_date) }),
    }
  }

  async getCharge(providerRef: string): Promise<Charge> {
    const invoice = await this.call<{
      id: string
      status: string
      invoice_url: string
      amount: number
      expiry_date?: string
    }>(`/v2/invoices/${encodeURIComponent(providerRef)}`, { method: 'GET' })

    return {
      provider: 'xendit',
      providerRef: invoice.id,
      status: INVOICE_STATUS[invoice.status] ?? 'awaiting_action',
      checkoutUrl: invoice.invoice_url,
      amount: fromXenditAmount(invoice.amount),
      ...(invoice.expiry_date === undefined
        ? {}
        : { expiresAt: new Date(invoice.expiry_date) }),
    }
  }

  async refund(input: RefundInput): Promise<Refund> {
    const refund = await this.call<{ id: string; status: string; amount: number }>(
      '/refunds',
      {
        method: 'POST',
        body: {
          invoice_id: input.providerRef,
          amount: toXenditAmount(input.amount),
          reason: 'REQUESTED_BY_CUSTOMER',
        },
        idempotencyKey: input.idempotencyKey,
      },
    )

    return {
      providerRef: refund.id,
      amount: fromXenditAmount(refund.amount),
      status:
        refund.status === 'SUCCEEDED'
          ? 'succeeded'
          : refund.status === 'FAILED'
            ? 'failed'
            : 'pending',
    }
  }

  /**
   * Xendit signs callbacks with a static per-account token in `x-callback-token`.
   *
   * There is no HMAC over the body, so this proves the *sender* knows the account's
   * token — it does not prove the body is untampered in transit. TLS is what covers
   * that. Anyone reasoning about this later should know it is Xendit's design and
   * not an omission here.
   *
   * Returns false rather than throwing, so the caller answers 401 uniformly.
   */
  verifyWebhook(input: {
    rawBody: string
    headers: Record<string, string | undefined>
  }): boolean {
    const token =
      input.headers['x-callback-token'] ?? input.headers['X-CALLBACK-TOKEN']
    if (typeof token !== 'string' || token === '') return false
    // Belt and braces, and knowingly redundant: `safeEqual` compares lengths first,
    // so an unconfigured account already rejects every non-empty token, and the
    // guard above rejects the empty one. Deleting this line changes no behaviour
    // and no test fails — it is kept because "an account with no token accepts
    // nothing" is the property, and it should survive someone rewriting
    // `safeEqual` without re-deriving why the length check was load-bearing.
    if (this.config.callbackToken === '') return false
    return safeEqual(token, this.config.callbackToken)
  }

  /**
   * Turn an invoice callback into the events the database should apply.
   *
   * Returns an array because some providers batch; Xendit sends one at a time, and
   * keeping the shape uniform is what lets the webhook route treat every provider
   * the same.
   *
   * The `externalId` is what `webhook_events.external_id` de-duplicates on. Xendit
   * does not put an event id on invoice callbacks, so it is composed from the
   * invoice id and the status — the pair that actually identifies the transition.
   * Using the invoice id alone would collapse "paid" and a later "expired" into one
   * event and silently drop the second.
   */
  parseWebhook(payload: unknown): PaymentEvent[] {
    if (payload === null || typeof payload !== 'object') return []
    const body = payload as Record<string, unknown>

    const id = typeof body['id'] === 'string' ? body['id'] : ''
    const externalRef = typeof body['external_id'] === 'string' ? body['external_id'] : ''
    const rawStatus = typeof body['status'] === 'string' ? body['status'] : ''
    if (id === '' || rawStatus === '') return []

    const status = INVOICE_STATUS[rawStatus]
    if (status === undefined) return []

    const amount = typeof body['amount'] === 'number' ? fromXenditAmount(body['amount']) : centavos(0)
    const feeRaw = body['fees_paid_amount']
    const channel = typeof body['payment_channel'] === 'string' ? body['payment_channel'] : ''
    const paidAt = typeof body['paid_at'] === 'string' ? new Date(body['paid_at']) : undefined
    const method = CHANNEL_TO_METHOD[channel]

    return [
      {
        providerRef: id,
        reference: externalRef,
        status,
        amount,
        ...(typeof feeRaw === 'number' ? { feeCentavos: fromXenditAmount(feeRaw) } : {}),
        ...(method === undefined ? {} : { method }),
        ...(paidAt === undefined || Number.isNaN(paidAt.getTime()) ? {} : { paidAt }),
        externalId: `${id}:${rawStatus}`,
        raw: payload,
      },
    ]
  }
}
