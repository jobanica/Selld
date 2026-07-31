import { centavos, type Centavos } from '@/lib/money'

import { hmacSha256Hex, marketplaceFetch, type MarketplaceHttpOptions } from './http'
import type {
  ExternalListing,
  ExternalOrder,
  MarketplaceCredentials,
  MarketplaceProvider,
  StockPush,
  StockPushResult,
} from './types'

/**
 * Lazada Open Platform.
 *
 * The second of the two, and different from Shopee in three ways that each cost
 * an hour if you assume they are the same:
 *
 * 1. **The signature covers every parameter, sorted.** `api_path` then each
 *    `key + value` in ascending key order, HMAC-SHA256, **uppercase** hex. Lower
 *    case is rejected with the same generic error as a wrong key, which is a
 *    miserable thing to debug, so the case is asserted in the test.
 * 2. **Success is the string `"0"`.** Not the number 0, not an absent field.
 *    `body.code === '0'`, and anything else is a failure regardless of the HTTP
 *    status — see `marketplaces/http.ts`.
 * 3. **Stock updates are XML.** The `/product/price_quantity/update` endpoint
 *    takes a `payload` parameter containing an XML document, even though every
 *    response is JSON. That is not a mistake in this file.
 *
 * Amounts are pesos as a decimal, converted here and nowhere else, same as
 * Shopee and for the same reason.
 */

export interface LazadaConfig extends MarketplaceHttpOptions {
  appKey: string
  appSecret: string
  now?: () => number
}

function toCentavos(amount: number): Centavos {
  return centavos(Math.round(amount * 100))
}

/**
 * `path + sorted(key + value)…`, HMAC-SHA256, uppercase hex.
 *
 * Exported because getting this wrong produces an error indistinguishable from
 * bad credentials, so it is worth testing against a known vector rather than
 * only through the provider.
 */
export async function lazadaSignature(
  appSecret: string,
  path: string,
  params: Record<string, string>,
): Promise<string> {
  const base =
    path +
    Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key] ?? ''}`)
      .join('')
  return (await hmacSha256Hex(appSecret, base)).toUpperCase()
}

const LAZADA_ENVELOPE = (body: Record<string, unknown>): { code: string; message: string } => {
  const code = String(body.code ?? '')
  return {
    // "0" means success. Anything else — including an empty string, which Lazada
    // never sends — is a failure worth classifying.
    code: code === '0' ? '' : code === '' ? 'error_unknown' : code,
    message: String(body.message ?? ''),
  }
}

/** Escape for the XML payload the price/quantity endpoint insists on. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function createLazadaProvider(config: LazadaConfig): MarketplaceProvider {
  const options = {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs ?? 15_000,
    fetchImpl: config.fetchImpl ?? fetch,
  }
  const now = config.now ?? Date.now

  const call = async (
    path: string,
    credentials: MarketplaceCredentials | null,
    extra: Record<string, string> = {},
  ): Promise<Record<string, unknown>> => {
    const params: Record<string, string> = {
      app_key: config.appKey,
      sign_method: 'sha256',
      timestamp: String(now()),
      ...(credentials === null ? {} : { access_token: credentials.accessToken }),
      ...extra,
    }
    const sign = await lazadaSignature(config.appSecret, path, params)
    const query = new URLSearchParams({ ...params, sign })

    const result = await marketplaceFetch(
      options,
      'lazada',
      `${path}?${query.toString()}`,
      { method: 'POST' },
      LAZADA_ENVELOPE,
    )
    return result.body
  }

  return {
    id: 'lazada',
    label: 'Lazada',

    async refreshCredentials(credentials) {
      const body = await call('/auth/token/refresh', null, {
        refresh_token: credentials.refreshToken ?? '',
      })
      const expiresIn = Number(body.expires_in ?? 604_800)
      return {
        shopId: credentials.shopId,
        accessToken: String(body.access_token ?? ''),
        refreshToken: String(body.refresh_token ?? credentials.refreshToken ?? ''),
        expiresAt: new Date(now() + expiresIn * 1000),
      }
    },

    async listListings(credentials) {
      const body = await call('/products/get', credentials, {
        filter: 'live',
        limit: '100',
        offset: '0',
      })
      const data = (body.data as Record<string, unknown>) ?? {}
      const products = (data.products as Record<string, unknown>[] | undefined) ?? []

      const listings: ExternalListing[] = []
      for (const product of products) {
        const attributes = (product.attributes as Record<string, unknown>) ?? {}
        for (const sku of (product.skus as Record<string, unknown>[] | undefined) ?? []) {
          listings.push({
            externalItemId: String(product.item_id),
            // Lazada's SkuId is the variation. A product with one SKU still has
            // one, so unlike Shopee there is no "no variation" case to special
            // case — which is why the mapping table allows either.
            externalVariationId: String(sku.SkuId),
            externalSku: String(sku.SellerSku ?? ''),
            name: String(attributes.name ?? ''),
            price: toCentavos(Number(sku.price ?? 0)),
            stock: Number(sku.quantity ?? 0),
          })
        }
      }
      return listings
    },

    async pushStock(credentials, updates) {
      const results: StockPushResult[] = []

      // One call per item, for the same reason as Shopee: two calls for one item
      // in the same run means the second overwrites the first.
      const byItem = new Map<string, StockPush[]>()
      for (const update of updates) {
        const existing = byItem.get(update.externalItemId)
        if (existing === undefined) byItem.set(update.externalItemId, [update])
        else existing.push(update)
      }

      for (const [itemId, group] of byItem) {
        const payload =
          `<Request><Product><Skus>` +
          group
            .map(
              (update) =>
                `<Sku><ItemId>${xmlEscape(itemId)}</ItemId>` +
                `<SkuId>${xmlEscape(update.externalVariationId ?? '')}</SkuId>` +
                `<Quantity>${Math.max(0, Math.trunc(update.onHand))}</Quantity></Sku>`,
            )
            .join('') +
          `</Skus></Product></Request>`

        try {
          await call('/product/price_quantity/update', credentials, { payload })
          for (const update of group) {
            results.push({
              externalItemId: update.externalItemId,
              ...(update.externalVariationId === undefined
                ? {}
                : { externalVariationId: update.externalVariationId }),
              ok: true,
            })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const update of group) {
            results.push({
              externalItemId: update.externalItemId,
              ...(update.externalVariationId === undefined
                ? {}
                : { externalVariationId: update.externalVariationId }),
              ok: false,
              error: message,
            })
          }
        }
      }
      return results
    },

    async pullOrders(credentials, since) {
      const body = await call('/orders/get', credentials, {
        created_after: since.toISOString(),
        limit: '50',
        sort_direction: 'ASC',
      })
      const data = (body.data as Record<string, unknown>) ?? {}
      const orders = (data.orders as Record<string, unknown>[] | undefined) ?? []

      const result: ExternalOrder[] = []
      for (const order of orders) {
        const address = (order.address_shipping as Record<string, unknown>) ?? {}
        const items = await call('/order/items/get', credentials, {
          order_id: String(order.order_id),
        })
        const lines = ((items.data as Record<string, unknown>[] | undefined) ?? []).map(
          (line) => ({
            externalItemId: String(line.product_id ?? ''),
            externalVariationId: String(line.sku_id ?? ''),
            externalSku: String(line.sku ?? ''),
            name: String(line.name ?? ''),
            qty: 1,
            unitPrice: toCentavos(Number(line.item_price ?? 0)),
          }),
        )

        const external: ExternalOrder = {
          externalOrderId: String(order.order_id),
          status: String(order.statuses ?? ''),
          placedAt: new Date(String(order.created_at ?? now())),
          buyerName: `${String(order.customer_first_name ?? '')} ${String(order.customer_last_name ?? '')}`.trim(),
          shippingAddress: {
            recipient: `${String(address.first_name ?? '')} ${String(address.last_name ?? '')}`.trim(),
            fullAddress: [address.address1, address.address2, address.address3]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(', '),
          },
          // Lazada returns one row per *unit*, not per line — two of the same SKU
          // are two rows. Collapsed here, or the order would show "1 × serum"
          // twice and the stock movement would deduct one.
          items: lines.reduce<ExternalOrder['items']>((accumulator, line) => {
            const existing = accumulator.find(
              (other) =>
                other.externalItemId === line.externalItemId &&
                other.externalVariationId === line.externalVariationId,
            )
            if (existing === undefined) accumulator.push(line)
            else existing.qty += 1
            return accumulator
          }, []),
          grandTotal: toCentavos(Number(order.price ?? 0)),
          isCod: String(order.payment_method ?? '').toLowerCase().includes('cash'),
        }
        const phone = String(address.phone ?? '')
        if (phone !== '') {
          external.shippingAddress.phone = phone
          external.buyerPhone = phone
        }
        const city = String(address.city ?? '')
        if (city !== '') external.shippingAddress.city = city
        result.push(external)
      }
      return result
    },
  }
}
