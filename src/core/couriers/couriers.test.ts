import { describe, expect, it, vi } from 'vitest'

import { centavos } from '@/lib/money'
import { IntegrationError } from '@/core/integration/errors'

import { FlashProvider } from './flash-provider'
import { JntProvider } from './jnt-provider'
import { classifyCourierError } from './http'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

function jnt(fetchImpl?: typeof fetch) {
  return new JntProvider({
    baseUrl: 'https://jnt.test',
    customerCode: 'CUST1',
    apiKey: 'k',
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
}

function flash(fetchImpl?: typeof fetch) {
  return new FlashProvider({
    baseUrl: 'https://flash.test',
    merchantId: 'M1',
    apiKey: 'k',
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
}

/**
 * The two couriers take money in different units, and that is the single most
 * dangerous difference between them.
 *
 * J&T quotes and collects in **pesos**; Flash uses **integer centavos** already.
 * Getting either backwards is a factor of a hundred on a COD amount — a rider
 * collecting ₱160,000 for a ₱1,600 order, or ₱16 for one. These tests read the
 * bytes that actually go on the wire, not the provider's return value, because the
 * bug would be in the request.
 */
describe('money on the wire', () => {
  it('sends J&T pesos', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { waybillNo: 'JT1', labelUrl: 'https://l/1.pdf' }),
    )
    await jnt(fetchMock as unknown as typeof fetch).book({
      reference: '0001',
      origin: addr(),
      destination: addr(),
      senderName: 'Rhea',
      senderPhone: '+639171234567',
      recipientName: 'Buyer',
      recipientPhone: '+639181234567',
      parcel: { weightGrams: 500 },
      service: 'standard',
      codAmount: centavos(160000),
      idempotencyKey: 'k1',
    })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.codAmount).toBe(1600)
    expect(body.weight).toBe(0.5)
  })

  it('sends Flash centavos, unconverted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { data: { pno: 'FL1', label_url: 'https://l/1.pdf' } }),
    )
    await flash(fetchMock as unknown as typeof fetch).book({
      reference: '0001',
      origin: addr(),
      destination: addr(),
      senderName: 'Rhea',
      senderPhone: '+639171234567',
      recipientName: 'Buyer',
      recipientPhone: '+639181234567',
      parcel: { weightGrams: 500 },
      service: 'standard',
      codAmount: centavos(160000),
      idempotencyKey: 'k1',
    })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.cod_amount).toBe(160000)
    expect(body.weight).toBe(500)
  })

  it('round-trips J&T amounts without losing a centavo', async () => {
    // 1024.09 * 100 is 102408.99999999999 in IEEE-754. The same trap as the Xendit
    // provider, hit here through a quote rather than an invoice.
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { rates: [{ serviceCode: 's', serviceName: 'Standard', amount: 1024.09 }] }),
    )
    const rates = await jnt(fetchMock as unknown as typeof fetch).quote({
      origin: addr(),
      destination: addr(),
      parcel: { weightGrams: 500 },
    })
    expect(rates[0]?.amount).toBe(102409)
  })
})

describe('booking safety', () => {
  it('rides the idempotency key so a retry cannot make a second parcel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { waybillNo: 'JT1' }))
    await jnt(fetchMock as unknown as typeof fetch).book(bookInput('tenant|shipment.book|order-1|0'))
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['X-Request-Id']).toBe(
      'tenant|shipment.book|order-1|0',
    )
    const body = JSON.parse(String(init.body))
    expect(body.requestId).toBe('tenant|shipment.book|order-1|0')
  })

  it('sends Flash its own idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: { pno: 'FL1' } }))
    await flash(fetchMock as unknown as typeof fetch).book(bookInput('key-2'))
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-2')
  })

  /**
   * A 200 with no waybill is worse than an error.
   *
   * It looks like success, so `record_shipment` would mark the order shipped with
   * nothing to track — the exact state a buyer phones about and nobody can answer.
   * Both providers must refuse it.
   */
  it('refuses a success response that carries no waybill', async () => {
    await expect(
      jnt(vi.fn().mockResolvedValue(json(200, { labelUrl: 'x' })) as unknown as typeof fetch).book(
        bookInput('k'),
      ),
    ).rejects.toThrow(/no waybill/)
    await expect(
      flash(vi.fn().mockResolvedValue(json(200, { data: {} })) as unknown as typeof fetch).book(
        bookInput('k'),
      ),
    ).rejects.toThrow(/no waybill/)
  })
})

/**
 * Retryable vs terminal decides whether a parcel lands in the retry queue or in
 * front of the seller. An unserviceable barangay is a 400 and will be a 400 forever;
 * retrying it delays the other 39 parcels and tells the seller nothing new.
 */
describe('error classification', () => {
  const cases = [
    [500, 'transient', true],
    [503, 'transient', true],
    [429, 'transient', true],
    [401, 'auth', false],
    [403, 'auth', false],
    [409, 'duplicate', false],
    [400, 'permanent', false],
    [422, 'permanent', false],
  ] as const

  for (const [status, kind, retryable] of cases) {
    it(`classifies ${status} as ${kind}`, () => {
      const error = classifyCourierError('jnt', '/api/orders', status, 'body')
      expect(error.kind).toBe(kind)
      expect(error.isRetryable).toBe(retryable)
    })
  }

  it('treats a timeout as transient, which is only safe because of the idempotency key', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('aborted'))
    await jnt(fetchMock as unknown as typeof fetch)
      .book(bookInput('k'))
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(IntegrationError)
        expect((error as IntegrationError).kind).toBe('transient')
      })
    expect.assertions(2)
  })
})

describe('tracking is normalised into one vocabulary', () => {
  it('maps J&T numeric codes', () => {
    const events = jnt().parseWebhook({
      waybillNo: 'JT1',
      details: [
        { scanStatus: '3', scanTime: '2026-07-31T02:00:00Z', desc: 'In transit', scanNetworkCity: 'Davao' },
        { scanStatus: '5', scanTime: '2026-07-31T09:00:00Z', desc: 'Delivered' },
      ],
    })
    expect(events.map((e) => e.status)).toEqual(['in_transit', 'delivered'])
    expect(events[0]?.rawCode).toBe('3')
    expect(events[0]?.location).toBe('Davao')
  })

  it('maps Flash string states', () => {
    const events = flash().parseWebhook({
      pno: 'FL1',
      routes: [
        { state: 'IN_TRANSIT', routed_at: 1785000000, message: 'Left facility' },
        { state: 'DELIVERED', routed_at: 1785030000, message: 'Received' },
      ],
    })
    expect(events.map((e) => e.status)).toEqual(['in_transit', 'delivered'])
    expect(events[0]?.rawCode).toBe('IN_TRANSIT')
  })

  /**
   * Flash sends epoch **seconds**. Reading them as milliseconds puts every parcel in
   * 1970 — which sorts a timeline backwards and makes "when was this delivered"
   * answer with a date before the store existed.
   */
  it('reads Flash timestamps as seconds, not milliseconds', () => {
    const [event] = flash().parseWebhook({
      pno: 'FL1',
      routes: [{ state: 'DELIVERED', routed_at: 1785000000, message: 'ok' }],
    })
    expect(event?.occurredAt.getUTCFullYear()).toBe(2026)
  })

  it('sorts events oldest-first however the courier ordered them', () => {
    const events = jnt().parseWebhook({
      waybillNo: 'JT1',
      details: [
        { scanStatus: '5', scanTime: '2026-07-31T09:00:00Z', desc: 'Delivered' },
        { scanStatus: '1', scanTime: '2026-07-30T01:00:00Z', desc: 'Booked' },
      ],
    })
    expect(events.map((e) => e.status)).toEqual(['booked', 'delivered'])
  })

  /**
   * An unmapped code becomes `unknown` rather than being dropped. A courier adding a
   * status must not make a parcel silently stop moving on a seller's screen.
   */
  it('keeps an unrecognised code as unknown rather than dropping the event', () => {
    const [jntEvent] = jnt().parseWebhook({
      waybillNo: 'JT1',
      details: [{ scanStatus: '77', scanTime: '2026-07-31T09:00:00Z', desc: 'New thing' }],
    })
    expect(jntEvent?.status).toBe('unknown')
    expect(jntEvent?.rawCode).toBe('77')

    const [flashEvent] = flash().parseWebhook({
      pno: 'FL1',
      routes: [{ state: 'SOMETHING_NEW', routed_at: 1785000000 }],
    })
    expect(flashEvent?.status).toBe('unknown')
  })

  it('yields nothing for payloads it does not understand', () => {
    for (const provider of [jnt(), flash()]) {
      expect(provider.parseWebhook(null)).toEqual([])
      expect(provider.parseWebhook('nope')).toEqual([])
      expect(provider.parseWebhook({})).toEqual([])
    }
  })

  it('drops an event with an unparseable timestamp rather than inventing one', () => {
    expect(
      jnt().parseWebhook({ waybillNo: 'JT1', details: [{ scanStatus: '3', scanTime: 'soon' }] }),
    ).toEqual([])
  })
})

function addr() {
  return {
    regionCode: '110000000',
    provinceCode: '112400000',
    cityCode: '112402000',
    barangayCode: '112402001',
    street: '1 Rizal St',
  }
}

function bookInput(idempotencyKey: string) {
  return {
    reference: '0001',
    origin: addr(),
    destination: addr(),
    senderName: 'Rhea',
    senderPhone: '+639171234567',
    recipientName: 'Buyer',
    recipientPhone: '+639181234567',
    parcel: { weightGrams: 500 },
    service: 'standard',
    idempotencyKey,
  }
}
