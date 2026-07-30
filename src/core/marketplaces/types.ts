import type { Centavos } from '@/lib/money'

/**
 * `MarketplaceProvider` — Shopee and Lazada first, TikTok Shop second (phase 17).
 *
 * Selld is the source of truth for stock. Sync is deliberately one-way outbound
 * for inventory and one-way inbound for orders:
 *
 *   stock:  Selld  ->  marketplace
 *   orders: Selld  <-  marketplace
 *
 * Two-way stock sync sounds better and is a trap — two systems both claiming
 * authority over the last unit is exactly the 11am double-sell in the avatar doc.
 */

export type MarketplaceId = 'shopee' | 'lazada' | 'tiktok'

export interface MarketplaceCredentials {
  shopId: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
}

export interface ExternalListing {
  externalItemId: string
  /** Variant-level id where the marketplace models variations separately. */
  externalVariationId?: string
  externalSku: string
  name: string
  price: Centavos
  stock: number
}

export interface StockPush {
  externalItemId: string
  externalVariationId?: string
  onHand: number
}

export interface StockPushResult {
  externalItemId: string
  externalVariationId?: string
  ok: boolean
  error?: string
}

/** An order pulled from a marketplace, ready to insert with `source='marketplace'`. */
export interface ExternalOrder {
  externalOrderId: string
  status: string
  placedAt: Date
  buyerName: string
  buyerPhone?: string
  shippingAddress: {
    recipient: string
    phone?: string
    fullAddress: string
    city?: string
    province?: string
    postalCode?: string
  }
  items: {
    externalItemId: string
    externalVariationId?: string
    externalSku: string
    name: string
    qty: number
    unitPrice: Centavos
  }[]
  /** What the marketplace says the buyer paid, for reconciliation. */
  grandTotal: Centavos
  /** Commission and fees the marketplace deducted — feeds the savings counter. */
  platformFees?: Centavos
  paymentMethod?: string
  isCod: boolean
}

export interface MarketplaceProvider {
  readonly id: MarketplaceId
  readonly label: string

  /** OAuth token refresh. Marketplace tokens are short-lived. */
  refreshCredentials(credentials: MarketplaceCredentials): Promise<MarketplaceCredentials>

  listListings(credentials: MarketplaceCredentials): Promise<ExternalListing[]>

  /** Push stock levels. Batched because rate limits are tight. */
  pushStock(
    credentials: MarketplaceCredentials,
    updates: readonly StockPush[],
  ): Promise<StockPushResult[]>

  pullOrders(
    credentials: MarketplaceCredentials,
    since: Date,
  ): Promise<ExternalOrder[]>
}
