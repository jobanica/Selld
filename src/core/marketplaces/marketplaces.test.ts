import { describe, expect, it } from 'vitest'

import { IntegrationError } from '@/core/integration/errors'
import { centavos } from '@/lib/money'

import { classifyMarketplaceError, hmacSha256Hex } from './http'
import { createLazadaProvider, lazadaSignature } from './lazada-provider'
import { createShopeeProvider, shopeeSignature } from './shopee-provider'
import { marketplaceRegistry } from './index'

/**
 * What these tests are for.
 *
 * Not "does the provider call the endpoint" — that is a fake talking to a fake.
 * The things worth pinning down are the three that silently produce a *wrong
 * number on a live listing*: a 200 that carries a refusal, a signature that is
 * right except for its case, and a batch where one item's failure takes the
 * other thirty-nine down with it.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }) as unknown as typeof fetch
  return { impl, calls }
}

const shopee = (fetchImpl: typeof fetch) =>
  createShopeeProvider({
    baseUrl: 'https://partner.example',
    partnerId: '2001',
    partnerKey: 'partner-secret',
    fetchImpl,
    now: () => 1_700_000_000_000,
  })

const lazada = (fetchImpl: typeof fetch) =>
  createLazadaProvider({
    baseUrl: 'https://api.example',
    appKey: 'app-1',
    appSecret: 'app-secret',
    fetchImpl,
    now: () => 1_700_000_000_000,
  })

const credentials = { shopId: '777', accessToken: 'tok', refreshToken: 'ref' }

describe('signatures', () => {
  it('Shopee signs partner id, path, timestamp, token and shop — and nothing else', async () => {
    const signature = await shopeeSignature({
      partnerId: '2001',
      partnerKey: 'partner-secret',
      path: '/api/v2/product/update_stock',
      timestamp: 1_700_000_000,
      accessToken: 'tok',
      shopId: '777',
    })
    // The vector: the body is deliberately absent from the base string, so two
    // different stock pushes a second apart sign identically. Pinning it here
    // means a "helpful" addition of the body to the base string fails loudly
    // rather than producing error_sign against the live API.
    const expected = await hmacSha256Hex(
      'partner-secret',
      '2001/api/v2/product/update_stock1700000000tok777',
    )
    expect(signature).toBe(expected)
    expect(signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Lazada sorts every parameter and shouts the hex', async () => {
    const signature = await lazadaSignature('app-secret', '/product/price_quantity/update', {
      timestamp: '1700000000000',
      app_key: 'app-1',
      access_token: 'tok',
    })
    // Sorted by key: access_token, app_key, timestamp — not the order they were
    // written in. Lazada rejects the unsorted form with the same error it uses
    // for a wrong secret, which is why this is asserted rather than assumed.
    const expected = (
      await hmacSha256Hex(
        'app-secret',
        '/product/price_quantity/updateaccess_tokentokapp_keyapp-1timestamp1700000000000',
      )
    ).toUpperCase()
    expect(signature).toBe(expected)
    expect(signature).toBe(signature.toUpperCase())
    expect(signature).not.toBe(signature.toLowerCase())
  })
})

describe('a 200 that is not a success', () => {
  it('Shopee: an error string in the body is a failure, not a push', async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse({ error: 'error_param', message: 'item_id not found', response: {} }),
    )
    const results = await shopee(impl).pushStock(credentials, [
      { externalItemId: '1', externalVariationId: '11', onHand: 3 },
    ])
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.error).toContain('error_param')
  })

  it('Shopee: an *empty* error string is the success case', async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: '', message: '', response: {} }))
    const results = await shopee(impl).pushStock(credentials, [
      { externalItemId: '1', externalVariationId: '11', onHand: 3 },
    ])
    expect(results[0]?.ok).toBe(true)
  })

  it('Lazada: code "0" is success and code "0" only', async () => {
    const ok = recordingFetch(() => jsonResponse({ code: '0', message: '' }))
    expect(
      (await lazada(ok.impl).pushStock(credentials, [
        { externalItemId: '9', externalVariationId: '90', onHand: 1 },
      ]))[0]?.ok,
    ).toBe(true)

    const refused = recordingFetch(() =>
      jsonResponse({ code: 'E001', message: 'sku not found', type: 'ISV' }),
    )
    const results = await lazada(refused.impl).pushStock(credentials, [
      { externalItemId: '9', externalVariationId: '90', onHand: 1 },
    ])
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.error).toContain('E001')
  })
})

describe('classification', () => {
  it('an expired token is never retried', () => {
    const error = classifyMarketplaceError('shopee', '/x', 200, 'error_auth', 'bad token')
    expect(error).toBeInstanceOf(IntegrationError)
    // A token that has expired will not un-expire on the next attempt, and
    // hammering it gets the partner app rate-limited across every shop.
    expect(error.isRetryable).toBe(false)
    expect(error.kind).toBe('auth')
  })

  it('a rate limit and a 5xx are retried', () => {
    expect(classifyMarketplaceError('shopee', '/x', 429, '', '').isRetryable).toBe(true)
    expect(classifyMarketplaceError('lazada', '/x', 503, '', '').isRetryable).toBe(true)
  })

  it('a listing that no longer exists is not', () => {
    expect(classifyMarketplaceError('lazada', '/x', 200, 'ItemNotFound', '').isRetryable).toBe(
      false,
    )
  })

  it('HTML from a load balancer is transient, not a parse bug of ours', async () => {
    const impl = (() =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      )) as unknown as typeof fetch
    const results = await shopee(impl).pushStock(credentials, [
      { externalItemId: '1', onHand: 0 },
    ])
    expect(results[0]?.ok).toBe(false)
  })
})

describe('pushing stock', () => {
  it('one listing failing does not take the batch down with it', async () => {
    // Three items; the fake refuses only the second.
    const failing = recordingFetch((_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { item_id: number }
      return body.item_id === 2
        ? jsonResponse({ error: 'error_param', message: 'no', response: {} })
        : jsonResponse({ error: '', message: '', response: {} })
    })

    const results = await shopee(failing.impl).pushStock(credentials, [
      { externalItemId: '1', externalVariationId: '11', onHand: 5 },
      { externalItemId: '2', externalVariationId: '22', onHand: 0 },
      { externalItemId: '3', externalVariationId: '33', onHand: 7 },
    ])

    expect(results.filter((r) => r.ok).map((r) => r.externalItemId)).toEqual(['1', '3'])
    expect(results.filter((r) => !r.ok).map((r) => r.externalItemId)).toEqual(['2'])
  })

  it('sends an absolute quantity, floored at zero, never a delta', async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse({ error: '', message: '', response: {} }),
    )
    await shopee(impl).pushStock(credentials, [
      { externalItemId: '1', externalVariationId: '11', onHand: -3 },
    ])
    const body = JSON.parse(String(calls[0]?.init.body ?? '{}')) as {
      stock_list: { seller_stock: { stock: number }[] }[]
    }
    // Negative availability is an accounting oddity here and an overselling
    // listing there — some marketplaces clamp it silently, some reject it.
    expect(body.stock_list[0]?.seller_stock[0]?.stock).toBe(0)
  })

  it('groups models under one item, so the second call cannot overwrite the first', async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse({ error: '', message: '', response: {} }),
    )
    await shopee(impl).pushStock(credentials, [
      { externalItemId: '1', externalVariationId: '11', onHand: 5 },
      { externalItemId: '1', externalVariationId: '12', onHand: 6 },
    ])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body ?? '{}')) as {
      stock_list: { model_id: number }[]
    }
    expect(body.stock_list.map((s) => s.model_id)).toEqual([11, 12])
  })

  it('Lazada sends the XML payload the endpoint insists on', async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ code: '0' }))
    await lazada(impl).pushStock(credentials, [
      { externalItemId: '9', externalVariationId: '90', onHand: 4 },
    ])
    const url = new URL(calls[0]?.url ?? 'https://x/')
    expect(url.searchParams.get('payload')).toContain('<Quantity>4</Quantity>')
    expect(url.searchParams.get('sign')).toMatch(/^[0-9A-F]{64}$/)
  })
})

describe('pulling orders', () => {
  it('Lazada returns a row per unit, and two of one SKU is one line of two', async () => {
    const { impl } = recordingFetch((url) => {
      if (url.includes('/orders/get')) {
        return jsonResponse({
          code: '0',
          data: {
            orders: [
              {
                order_id: 4001,
                created_at: '2026-07-31T10:00:00+08:00',
                customer_first_name: 'Ana',
                customer_last_name: 'Reyes',
                price: '598.00',
                payment_method: 'Cash on Delivery',
                address_shipping: { first_name: 'Ana', last_name: 'Reyes', phone: '09171234567' },
              },
            ],
          },
        })
      }
      return jsonResponse({
        code: '0',
        data: [
          { product_id: 9, sku_id: 90, sku: 'RH-30ML', name: 'Serum', item_price: '299.00' },
          { product_id: 9, sku_id: 90, sku: 'RH-30ML', name: 'Serum', item_price: '299.00' },
        ],
      })
    })

    const orders = await lazada(impl).pullOrders(credentials, new Date(0))
    expect(orders).toHaveLength(1)
    // Two rows for one SKU is a quantity of two, not two lines of one — and it
    // is certainly not one line of one, which would deduct half the stock.
    expect(orders[0]?.items).toHaveLength(1)
    expect(orders[0]?.items[0]?.qty).toBe(2)
    expect(orders[0]?.grandTotal).toBe(centavos(59_800))
    expect(orders[0]?.isCod).toBe(true)
  })

  it('Shopee prices survive the peso round trip', async () => {
    const { impl } = recordingFetch((url) => {
      if (url.includes('get_order_list')) {
        return jsonResponse({ error: '', response: { order_list: [{ order_sn: 'SPE-1' }] } })
      }
      return jsonResponse({
        error: '',
        response: {
          order_list: [
            {
              order_sn: 'SPE-1',
              order_status: 'READY_TO_SHIP',
              create_time: 1_700_000_000,
              buyer_username: 'marites',
              total_amount: 1024.09,
              payment_method: 'Cash On Delivery',
              recipient_address: { name: 'Marites', phone: '09171234567', full_address: '21 Rizal' },
              item_list: [
                {
                  item_id: 1,
                  model_id: 11,
                  model_sku: 'RH-30ML',
                  item_name: 'Serum',
                  model_quantity_purchased: 1,
                  model_discounted_price: 1024.09,
                },
              ],
            },
          ],
        },
      })
    })

    const orders = await shopee(impl).pullOrders(credentials, new Date(0))
    // 1024.09 * 100 is 102408.99999999999 in IEEE-754. Truncation loses a
    // centavo here, exactly as it does in the J&T and Xendit providers.
    expect(orders[0]?.grandTotal).toBe(centavos(102_409))
    expect(orders[0]?.items[0]?.unitPrice).toBe(centavos(102_409))
    expect(orders[0]?.items[0]?.externalVariationId).toBe('11')
  })
})

describe('the registry', () => {
  it('is empty at import time, so tests can install fakes', () => {
    // Registration happens at app startup, never at import — the same rule the
    // courier, SMS and payment registries follow.
    expect(marketplaceRegistry.all()).toEqual([])
  })
})
