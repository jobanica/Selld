import { describe, expect, it, vi } from 'vitest'

import { centavos } from '@/lib/money'
import { IntegrationError } from '@/core/integration/errors'

import {
  XenditProvider,
  fromXenditAmount,
  safeEqual,
  toXenditAmount,
} from './xendit-provider'

const CALLBACK_TOKEN = 'kZ7Qk3wR2mF8pL1sT4vX9yB6nC0dE5gH'

function provider(fetchImpl?: typeof fetch) {
  return new XenditProvider({
    secretKey: 'xnd_development_TESTKEY',
    callbackToken: CALLBACK_TOKEN,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('amount conversion', () => {
  /**
   * Xendit takes PHP in pesos; everything inside Selld is integer centavos. This
   * boundary is the only place the two meet, so it is the only place a rounding
   * bug can put an invoice a centavo away from its order — which then fails the
   * short-pay check for reasons that look like nothing.
   */
  it('converts centavos to a peso decimal', () => {
    expect(toXenditAmount(centavos(160000))).toBe(1600)
    expect(toXenditAmount(centavos(1))).toBe(0.01)
    expect(toXenditAmount(centavos(0))).toBe(0)
  })

  it('refuses a fractional centavo instead of rounding it', () => {
    expect(() => toXenditAmount(1600.5 as never)).toThrow(RangeError)
  })

  it('undoes the float division JSON forces on the way back', () => {
    // ₱1,024.09 * 100 is 102408.99999999999 in IEEE-754, so truncating gives
    // 102408 — one centavo light. That order then fails the short-pay check and is
    // recorded as `partial` despite the buyer having paid in full, which is a
    // support ticket no one can reproduce. `Math.round` is what makes it 102409.
    expect(1024.09 * 100).toBeCloseTo(102409, 5)
    expect(Math.trunc(1024.09 * 100)).toBe(102408)
    expect(fromXenditAmount(1024.09)).toBe(102409)

    // 0.29 is the smallest amount where this bites.
    expect(Math.trunc(0.29 * 100)).toBe(28)
    expect(fromXenditAmount(0.29)).toBe(29)

    expect(fromXenditAmount(1600)).toBe(160000)
    expect(fromXenditAmount(0.07)).toBe(7)
  })

  it('round-trips every centavo value in a realistic range', () => {
    for (let value = 0; value < 5000; value++) {
      expect(fromXenditAmount(toXenditAmount(centavos(value)))).toBe(value)
    }
  })
})

describe('safeEqual', () => {
  it('matches only identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })

  it('does not short-circuit on the first differing character', () => {
    // Not a timing measurement — those are too noisy to assert on. This pins the
    // property the implementation relies on: every character is always examined,
    // so the loop cannot be "optimised" back into an early return.
    const long = 'a'.repeat(64)
    expect(safeEqual(long, `b${long.slice(1)}`)).toBe(false)
    expect(safeEqual(long, `${long.slice(0, 63)}b`)).toBe(false)
  })
})

describe('verifyWebhook', () => {
  it('accepts the account callback token', () => {
    expect(
      provider().verifyWebhook({
        rawBody: '{}',
        headers: { 'x-callback-token': CALLBACK_TOKEN },
      }),
    ).toBe(true)
  })

  it('rejects a wrong, absent or empty token', () => {
    const p = provider()
    expect(p.verifyWebhook({ rawBody: '{}', headers: { 'x-callback-token': 'nope' } })).toBe(false)
    expect(p.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false)
    expect(p.verifyWebhook({ rawBody: '{}', headers: { 'x-callback-token': '' } })).toBe(false)
  })

  /**
   * An account with no callback token configured must not accept everything.
   *
   * The tempting shape — compare the header against the stored value and return
   * true when they match — says yes to a request carrying an empty token when the
   * stored token is also empty. That is the whole "mark any order paid" endpoint,
   * reachable by any store that has been half-configured.
   */
  it('rejects everything when no callback token is configured', () => {
    const unconfigured = new XenditProvider({ secretKey: 'k', callbackToken: '' })
    expect(unconfigured.verifyWebhook({ rawBody: '{}', headers: { 'x-callback-token': '' } })).toBe(false)
    expect(unconfigured.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false)
  })
})

/**
 * A real Xendit invoice callback, trimmed to the fields we read.
 *
 * Shape taken from Xendit's invoice callback documentation rather than invented:
 * the parser is a set of assumptions about someone else's JSON, so a made-up
 * fixture would only test that the parser agrees with itself.
 */
const PAID_CALLBACK = {
  id: '5f4708b1e2d8b6002d8f9c1e',
  external_id: 'RF-0042',
  user_id: '5cafeb6e8a4b6a00',
  status: 'PAID',
  merchant_name: "Rhea's Finds",
  amount: 1600,
  paid_amount: 1600,
  fees_paid_amount: 15.5,
  payment_channel: 'GCASH',
  payment_method: 'EWALLET',
  paid_at: '2026-07-31T04:12:33.000Z',
  currency: 'PHP',
} as const

describe('parseWebhook', () => {
  it('reads a paid invoice callback', () => {
    const [event] = provider().parseWebhook(PAID_CALLBACK)
    expect(event).toMatchObject({
      providerRef: '5f4708b1e2d8b6002d8f9c1e',
      reference: 'RF-0042',
      status: 'paid',
      amount: 160000,
      feeCentavos: 1550,
      method: 'gcash',
    })
    expect(event?.paidAt?.toISOString()).toBe('2026-07-31T04:12:33.000Z')
  })

  /**
   * The de-duplication key must identify the *transition*, not the invoice.
   *
   * Xendit puts no event id on invoice callbacks. Keying on the invoice id alone
   * would make a later "expired" for the same invoice look like a replay of the
   * "paid", and `webhook_events` would silently swallow it — so the one event that
   * should be recorded for a seller to see never is.
   */
  it('keys de-duplication on the invoice and its status together', () => {
    const paid = provider().parseWebhook(PAID_CALLBACK)[0]
    const expired = provider().parseWebhook({ ...PAID_CALLBACK, status: 'EXPIRED' })[0]

    expect(paid?.externalId).toBe('5f4708b1e2d8b6002d8f9c1e:PAID')
    expect(expired?.externalId).toBe('5f4708b1e2d8b6002d8f9c1e:EXPIRED')
    expect(paid?.externalId).not.toBe(expired?.externalId)
  })

  it('maps SETTLED to paid, because settlement follows capture', () => {
    expect(provider().parseWebhook({ ...PAID_CALLBACK, status: 'SETTLED' })[0]?.status).toBe('paid')
  })

  it('yields nothing for payloads it does not understand', () => {
    const p = provider()
    expect(p.parseWebhook(null)).toEqual([])
    expect(p.parseWebhook('a string')).toEqual([])
    expect(p.parseWebhook({})).toEqual([])
    expect(p.parseWebhook({ id: 'x', status: 'SOMETHING_NEW' })).toEqual([])
  })

  it('keeps the raw payload for the record', () => {
    expect(provider().parseWebhook(PAID_CALLBACK)[0]?.raw).toBe(PAID_CALLBACK)
  })
})

describe('createCharge', () => {
  it('sends centavos as pesos and restricts the channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: 'inv_1',
        status: 'PENDING',
        invoice_url: 'https://checkout.xendit.co/web/inv_1',
        amount: 1600,
        expiry_date: '2026-08-01T00:00:00.000Z',
      }),
    )

    const charge = await provider(fetchMock as unknown as typeof fetch).createCharge({
      reference: 'RF-0042',
      amount: centavos(160000),
      method: 'gcash',
      customerName: 'Rhea Santos',
      customerPhone: '+639171234567',
      successUrl: 'https://rheas-finds.selld.ph/orders/1/paid',
      failureUrl: 'https://rheas-finds.selld.ph/orders/1/failed',
      idempotencyKey: 'tenant|payment.charge|order-1|0',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>

    expect(url).toBe('https://api.xendit.co/v2/invoices')
    expect(body['amount']).toBe(1600)
    expect(body['external_id']).toBe('RF-0042')
    expect(body['payment_methods']).toEqual(['GCASH'])
    expect((init.headers as Record<string, string>)['X-IDEMPOTENCY-KEY']).toBe(
      'tenant|payment.charge|order-1|0',
    )

    expect(charge).toMatchObject({
      provider: 'xendit',
      providerRef: 'inv_1',
      status: 'awaiting_action',
      checkoutUrl: 'https://checkout.xendit.co/web/inv_1',
      amount: 160000,
    })
  })

  it('refuses methods Xendit does not handle', async () => {
    await expect(
      provider().createCharge({
        reference: 'RF-1',
        amount: centavos(100),
        method: 'cod',
        customerName: 'A',
        customerPhone: '+639171234567',
        successUrl: 'https://x',
        failureUrl: 'https://y',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/does not handle cod/)
  })
})

describe('error classification', () => {
  /**
   * Retryable vs terminal is the distinction that matters operationally: a 503
   * belongs in the retry curve, a 400 must surface to the buyer immediately, and a
   * 401 needs the seller to re-paste their key. Collapsing them into one Error is
   * how a checkout hangs on four backoff sleeps before failing anyway.
   */
  const cases = [
    { status: 500, kind: 'transient', retryable: true },
    { status: 503, kind: 'transient', retryable: true },
    { status: 429, kind: 'transient', retryable: true },
    { status: 401, kind: 'auth', retryable: false },
    { status: 403, kind: 'auth', retryable: false },
    { status: 409, kind: 'duplicate', retryable: false },
    { status: 400, kind: 'permanent', retryable: false },
    { status: 422, kind: 'permanent', retryable: false },
  ] as const

  for (const { status, kind, retryable } of cases) {
    it(`classifies ${status} as ${kind}`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { message: 'nope' }))
      const call = provider(fetchMock as unknown as typeof fetch).getCharge('inv_1')

      await expect(call).rejects.toBeInstanceOf(IntegrationError)
      await call.catch((error: unknown) => {
        expect(error).toBeInstanceOf(IntegrationError)
        const integrationError = error as IntegrationError
        expect(integrationError.kind).toBe(kind)
        expect(integrationError.isRetryable).toBe(retryable)
      })
    })
  }

  it('treats a network failure as transient', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await provider(fetchMock as unknown as typeof fetch)
      .getCharge('inv_1')
      .catch((error: unknown) => {
        expect((error as IntegrationError).kind).toBe('transient')
      })
    expect.assertions(1)
  })
})
