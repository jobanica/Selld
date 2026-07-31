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
 * Shopee Open Platform v2.
 *
 * The bigger of the two by PH social-seller volume, and the one the done-when
 * names, so it is the one whose edges are worked hardest here.
 *
 * ## The signature is over a path, not over a body
 *
 * Shopee signs `partner_id + api_path + timestamp + access_token + shop_id` with
 * the partner key — the request *body* is not in it. That is worth stating
 * because it looks like a mistake: it means the signature authenticates who is
 * calling and when, not what they asked for. Nothing we can do about it, and it
 * is why the timestamp window matters — a signature more than five minutes old is
 * rejected, so a worker whose clock has drifted fails every call with
 * `error_sign` and no other symptom.
 *
 * ## Amounts
 *
 * Shopee quotes in **pesos as a decimal number**. Selld is integer centavos
 * everywhere (hard rule 2), so the conversion happens here and nowhere else, with
 * `Math.round` rather than truncation — `1024.09 * 100` is `102408.99999999999`
 * in IEEE-754 and truncating loses a centavo, which is the same trap the J&T and
 * Xendit providers have a round-trip test for.
 *
 * ## Stock is set, never adjusted
 *
 * `update_stock` takes an absolute number. That is what makes a retry after a
 * timeout safe: pushing 3 twice leaves 3, whereas "decrement by 1" twice leaves a
 * listing two units short and no way to tell afterwards.
 */

export interface ShopeeConfig extends MarketplaceHttpOptions {
  partnerId: string
  partnerKey: string
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number
}

function toPesos(amount: Centavos): number {
  if (!Number.isInteger(amount)) {
    throw new RangeError(`Amount must be whole centavos, got ${String(amount)}`)
  }
  return amount / 100
}

function toCentavos(amount: number): Centavos {
  return centavos(Math.round(amount * 100))
}

/** `partner_id + path + timestamp + access_token + shop_id`, HMAC-SHA256, hex. */
export async function shopeeSignature(input: {
  partnerId: string
  partnerKey: string
  path: string
  timestamp: number
  accessToken?: string
  shopId?: string
}): Promise<string> {
  const base =
    `${input.partnerId}${input.path}${input.timestamp}` +
    `${input.accessToken ?? ''}${input.shopId ?? ''}`
  return hmacSha256Hex(input.partnerKey, base)
}

const SHOPEE_ENVELOPE = (body: Record<string, unknown>): { code: string; message: string } => ({
  // `error` is an empty string on success, so this reads the *value*, never the
  // presence of the key.
  code: typeof body.error === 'string' ? body.error : '',
  message: typeof body.message === 'string' ? body.message : '',
})

export function createShopeeProvider(config: ShopeeConfig): MarketplaceProvider {
  const options = {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs ?? 15_000,
    fetchImpl: config.fetchImpl ?? fetch,
  }
  const now = config.now ?? Date.now

  const call = async (
    path: string,
    credentials: MarketplaceCredentials,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ): Promise<Record<string, unknown>> => {
    const timestamp = Math.floor(now() / 1000)
    const sign = await shopeeSignature({
      partnerId: config.partnerId,
      partnerKey: config.partnerKey,
      path,
      timestamp,
      accessToken: credentials.accessToken,
      shopId: credentials.shopId,
    })
    const query = new URLSearchParams({
      partner_id: config.partnerId,
      timestamp: String(timestamp),
      access_token: credentials.accessToken,
      shop_id: credentials.shopId,
      sign,
      ...(init.query ?? {}),
    })
    const result = await marketplaceFetch(
      options,
      'shopee',
      `${path}?${query.toString()}`,
      { method: init.method, ...(init.body === undefined ? {} : { body: init.body }) },
      SHOPEE_ENVELOPE,
    )
    return (result.body.response as Record<string, unknown>) ?? {}
  }

  return {
    id: 'shopee',
    label: 'Shopee',

    async refreshCredentials(credentials) {
      const timestamp = Math.floor(now() / 1000)
      const path = '/api/v2/auth/access_token/get'
      // The refresh call is signed *without* the access token — it is the one
      // call made when the access token is what has gone bad.
      const sign = await shopeeSignature({
        partnerId: config.partnerId,
        partnerKey: config.partnerKey,
        path,
        timestamp,
      })
      const query = new URLSearchParams({
        partner_id: config.partnerId,
        timestamp: String(timestamp),
        sign,
      })
      const result = await marketplaceFetch(
        options,
        'shopee',
        `${path}?${query.toString()}`,
        {
          method: 'POST',
          body: {
            refresh_token: credentials.refreshToken ?? '',
            shop_id: Number(credentials.shopId),
            partner_id: Number(config.partnerId),
          },
        },
        SHOPEE_ENVELOPE,
      )
      const body = result.body
      const expiresIn = Number(body.expire_in ?? 14_400)
      return {
        shopId: credentials.shopId,
        accessToken: String(body.access_token ?? ''),
        refreshToken: String(body.refresh_token ?? credentials.refreshToken ?? ''),
        expiresAt: new Date(now() + expiresIn * 1000),
      }
    },

    async listListings(credentials) {
      const list = await call('/api/v2/product/get_item_list', credentials, {
        method: 'GET',
        query: { offset: '0', page_size: '100', item_status: 'NORMAL' },
      })
      const ids = ((list.item as { item_id: number }[] | undefined) ?? []).map((i) =>
        String(i.item_id),
      )
      if (ids.length === 0) return []

      const detail = await call('/api/v2/product/get_item_base_info', credentials, {
        method: 'GET',
        query: { item_id_list: ids.join(',') },
      })

      const listings: ExternalListing[] = []
      for (const item of (detail.item_list as Record<string, unknown>[] | undefined) ?? []) {
        const models = (item.model_list as Record<string, unknown>[] | undefined) ?? []
        const priceInfo = (item.price_info as Record<string, unknown>[] | undefined) ?? []
        const basePrice = toCentavos(Number(priceInfo[0]?.current_price ?? 0))

        if (models.length === 0) {
          listings.push({
            externalItemId: String(item.item_id),
            externalSku: String(item.item_sku ?? ''),
            name: String(item.item_name ?? ''),
            price: basePrice,
            stock: Number(
              (item.stock_info_v2 as { summary_info?: { total_available_stock?: number } })
                ?.summary_info?.total_available_stock ?? 0,
            ),
          })
          continue
        }

        // A Shopee item with models is a Selld *product* with variants, and each
        // model is its own listing — mapping at item level would push one
        // number for several variants, which is the overselling this phase is
        // about.
        for (const model of models) {
          listings.push({
            externalItemId: String(item.item_id),
            externalVariationId: String(model.model_id),
            externalSku: String(model.model_sku ?? item.item_sku ?? ''),
            name: `${String(item.item_name ?? '')} — ${String(model.model_name ?? '')}`,
            price: toCentavos(
              Number(
                (model.price_info as { current_price?: number }[] | undefined)?.[0]
                  ?.current_price ?? 0,
              ),
            ),
            stock: Number(
              (model.stock_info_v2 as { summary_info?: { total_available_stock?: number } })
                ?.summary_info?.total_available_stock ?? 0,
            ),
          })
        }
      }
      return listings
    },

    async pushStock(credentials, updates) {
      const results: StockPushResult[] = []

      // Shopee's update_stock takes one item and its models, so the batch is
      // grouped by item rather than sent flat. Not an optimisation — sending the
      // same item twice in one run makes the second call overwrite the first.
      const byItem = new Map<string, StockPush[]>()
      for (const update of updates) {
        const existing = byItem.get(update.externalItemId)
        if (existing === undefined) byItem.set(update.externalItemId, [update])
        else existing.push(update)
      }

      for (const [itemId, group] of byItem) {
        try {
          await call('/api/v2/product/update_stock', credentials, {
            method: 'POST',
            body: {
              item_id: Number(itemId),
              stock_list: group.map((update) => ({
                model_id: Number(update.externalVariationId ?? 0),
                seller_stock: [{ stock: Math.max(0, Math.trunc(update.onHand)) }],
              })),
            },
          })
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
          // One item failing must not fail the batch — the same rule bulk
          // courier booking follows, and for the same reason: 39 other listings
          // are still telling the truth and should carry on doing so.
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
      const list = await call('/api/v2/order/get_order_list', credentials, {
        method: 'GET',
        query: {
          time_range_field: 'create_time',
          time_from: String(Math.floor(since.getTime() / 1000)),
          time_to: String(Math.floor(now() / 1000)),
          page_size: '50',
        },
      })
      const refs = ((list.order_list as { order_sn: string }[] | undefined) ?? []).map(
        (o) => o.order_sn,
      )
      if (refs.length === 0) return []

      const detail = await call('/api/v2/order/get_order_detail', credentials, {
        method: 'GET',
        query: { order_sn_list: refs.join(','), response_optional_fields: 'buyer_username,item_list,recipient_address' },
      })

      return ((detail.order_list as Record<string, unknown>[] | undefined) ?? []).map((order) => {
        const address = (order.recipient_address as Record<string, unknown>) ?? {}
        const items = (order.item_list as Record<string, unknown>[] | undefined) ?? []
        const external: ExternalOrder = {
          externalOrderId: String(order.order_sn),
          status: String(order.order_status ?? ''),
          placedAt: new Date(Number(order.create_time ?? 0) * 1000),
          buyerName: String(order.buyer_username ?? address.name ?? ''),
          shippingAddress: {
            recipient: String(address.name ?? ''),
            fullAddress: String(address.full_address ?? ''),
          },
          items: items.map((item) => ({
            externalItemId: String(item.item_id),
            externalSku: String(item.model_sku ?? item.item_sku ?? ''),
            name: String(item.item_name ?? ''),
            qty: Number(item.model_quantity_purchased ?? 1),
            unitPrice: toCentavos(Number(item.model_discounted_price ?? 0)),
          })),
          grandTotal: toCentavos(Number(order.total_amount ?? 0)),
          // Shopee's own words for it. Kept verbatim rather than normalised,
          // because "which of these is COD" is a question the ingest answers.
          isCod: String(order.payment_method ?? '').toUpperCase().includes('COD'),
        }
        const phone = String(address.phone ?? '')
        if (phone !== '') {
          external.shippingAddress.phone = phone
          external.buyerPhone = phone
        }
        const city = String(address.city ?? '')
        if (city !== '') external.shippingAddress.city = city
        const variationId = items[0]?.model_id
        if (variationId !== undefined) {
          external.items.forEach((line, index) => {
            const model = items[index]?.model_id
            if (model !== undefined && model !== 0) line.externalVariationId = String(model)
          })
        }
        return external
      })
    },
  }
}

/** Pesos in, centavos out — exported so the round-trip test can reach it. */
export const shopeeAmounts = { toPesos, toCentavos }
