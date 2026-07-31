import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Marketplace sync, seller side.
 *
 * The whole screen is one RPC. `marketplace_overview` returns the shops, the
 * listings and the queue in a single jsonb document, for the same reason the
 * storefront's pages do: three round trips to render one screen is three chances
 * for it to be half-drawn, and the three things are only meaningful together —
 * "twelve listings, nine linked" is the sentence the seller is here to read.
 */

export interface MarketplaceConnection {
  id: string
  platform: 'shopee' | 'lazada' | 'tiktok'
  shopId: string
  shopName: string | null
  syncStock: boolean
  syncOrders: boolean
  status: 'disconnected' | 'connected' | 'expired' | 'error'
  hasCredentials: boolean
  lastStockPushAt: string | null
  lastOrderPullAt: string | null
  lastError: string | null
  listings: number
  mapped: number
}

export interface MarketplaceListing {
  id: string
  connectionId: string
  platform: string
  externalItemId: string
  externalSku: string | null
  name: string | null
  price: number | null
  variantId: string | null
  variantSku: string | null
  productName: string | null
  sellable: number | null
  lastPushedStock: number | null
  lastPushedAt: string | null
}

export interface MarketplaceIssue {
  id: string
  kind: 'unmapped_listing' | 'unmapped_sku' | 'push_rejected' | 'order_conflict'
  reference: string | null
  message: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface MarketplaceOverview {
  connections: MarketplaceConnection[]
  listings: MarketplaceListing[]
  issues: MarketplaceIssue[]
}

export async function fetchMarketplaceOverview(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<MarketplaceOverview> {
  const { data, error } = await client.rpc('marketplace_overview', { p_tenant_id: tenantId })
  if (error) throw error
  return data as unknown as MarketplaceOverview
}

export async function connectShop(
  input: { tenantId: string; platform: string; shopId: string; shopName: string },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client.rpc('marketplace_connect', {
    p_tenant_id: input.tenantId,
    p_platform: input.platform,
    p_shop_id: input.shopId,
    p_shop_name: input.shopName,
  })
  if (error) throw error
  return data as unknown as string
}

export async function setSync(
  input: { connectionId: string; syncStock?: boolean; syncOrders?: boolean },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('marketplace_set_sync', {
    p_connection_id: input.connectionId,
    // Omitted rather than sent as null. The function reads `coalesce(p_x, x)`
    // and both arguments default to null, so "absent" and "null" mean the same
    // thing here — leave that switch alone. Safe only because
    // `marketplace_set_sync` has exactly one signature: PostgREST picks an
    // overload from the set of argument *names* in the body, so an absent key
    // would otherwise choose a different function.
    ...(input.syncStock === undefined ? {} : { p_sync_stock: input.syncStock }),
    ...(input.syncOrders === undefined ? {} : { p_sync_orders: input.syncOrders }),
  })
  if (error) throw error
}

export async function mapListing(
  input: { listingId: string; variantId: string | null },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('marketplace_map_listing', {
    p_listing_id: input.listingId,
    // Absent means null means unmap — the argument defaults to null, and this
    // function has one signature. Same reasoning as `marketplace_set_sync`.
    ...(input.variantId === null ? {} : { p_variant_id: input.variantId }),
  })
  if (error) throw error
}

export async function resolveIssue(
  issueId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('marketplace_issue_resolve', { p_issue_id: issueId })
  if (error) throw error
}

/**
 * Ask the marketplace what it is selling, or push/pull now.
 *
 * Through the server, because the partner credentials and the encryption key are
 * the server's. The dashboard never sees either.
 */
export async function syncNow(
  connectionId: string,
  action: 'import' | 'push' | 'pull',
  client: SelldClient = getSupabase(),
): Promise<Record<string, number>> {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token ?? ''

  const response = await fetch(`/api/marketplace/${connectionId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error ?? 'sync_failed')
  }
  return (await response.json()) as Record<string, number>
}

export interface VariantOption {
  id: string
  sku: string
  label: string
}

/** Every variant the seller could point a listing at, with its product name. */
export async function fetchVariantOptions(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<VariantOption[]> {
  const { data, error } = await client
    .from('product_variants')
    .select('id, sku, products(name)')
    .eq('tenant_id', tenantId)
    .order('sku')
  if (error) throw error
  return (data ?? []).map((row) => {
    const product = row.products as unknown as { name: string } | null
    return {
      id: row.id,
      sku: row.sku ?? '',
      label: `${product?.name ?? 'Product'} · ${row.sku ?? ''}`,
    }
  })
}

export function describeMarketplaceError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('already_mapped')) return 'marketplaces.errorAlreadyMapped'
  if (message.includes('not_configured')) return 'marketplaces.errorNotConfigured'
  if (message.includes('no_provider')) return 'marketplaces.errorNoProvider'
  if (message.includes('no_credentials')) return 'marketplaces.errorNoCredentials'
  if (message.includes('not_allowed') || message.includes('Not allowed'))
    return 'marketplaces.errorNotAllowed'
  if (message.includes('marketplace_connections_sync_needs_credentials'))
    return 'marketplaces.errorNeedsCredentials'
  return 'marketplaces.errorUnknown'
}
