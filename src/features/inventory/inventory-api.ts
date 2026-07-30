import { getSupabase, type SelldClient } from '@/lib/supabase/client'

/**
 * Inventory reads and writes.
 *
 * Every write goes through an RPC, never a direct table update. That is not
 * ceremony: `on_hand` is derived from the movement ledger and a guard trigger
 * rejects direct writes, so an `.update({ on_hand })` here would simply fail. The
 * RPCs also hold the advisory locks that make concurrent reservations safe.
 */

/**
 * Why stock changed. Mirrors the database CHECK constraint, so a value that
 * typechecks here cannot be rejected at runtime for being unknown.
 */
export const STOCK_REASONS = [
  'receive',
  'adjustment',
  'return',
  'damage',
  'rts',
  'transfer',
  'sale',
] as const

export type StockReason = (typeof STOCK_REASONS)[number]

/** Reasons a seller may pick in the adjustment UI. `sale` is system-only. */
export const MANUAL_STOCK_REASONS: StockReason[] = [
  'receive',
  'adjustment',
  'return',
  'damage',
  'rts',
]

export interface InventoryRow {
  id: string
  variantId: string
  locationId: string
  locationName: string
  productId: string
  productName: string
  sku: string | null
  onHand: number
  reserved: number
  incoming: number
  available: number
  lowStockThreshold: number | null
  isLow: boolean
  updatedAt: string
}

export async function fetchInventory(
  tenantId: string,
  options: { search?: string; lowOnly?: boolean } = {},
  client: SelldClient = getSupabase(),
): Promise<InventoryRow[]> {
  let request = client
    .from('inventory_overview')
    .select(
      'id, variant_id, location_id, location_name, product_id, product_name, sku, on_hand, reserved, incoming, available, low_stock_threshold, is_low, updated_at',
    )
    .eq('tenant_id', tenantId)
    .order('product_name')

  if (options.lowOnly) request = request.eq('is_low', true)
  if (options.search && options.search.trim() !== '') {
    request = request.ilike('product_name', `%${options.search.trim()}%`)
  }

  const { data, error } = await request
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id ?? '',
    variantId: row.variant_id ?? '',
    locationId: row.location_id ?? '',
    locationName: row.location_name ?? '',
    productId: row.product_id ?? '',
    productName: row.product_name ?? '',
    sku: row.sku,
    onHand: row.on_hand ?? 0,
    reserved: row.reserved ?? 0,
    incoming: row.incoming ?? 0,
    available: row.available ?? 0,
    lowStockThreshold: row.low_stock_threshold,
    isLow: row.is_low ?? false,
    updatedAt: row.updated_at ?? '',
  }))
}

export interface StockMovement {
  id: string
  delta: number
  reason: StockReason
  note: string | null
  referenceType: string | null
  createdAt: string
  createdByName: string | null
}

/** The per-variant ledger, newest first — what explains the current number. */
export async function fetchMovements(
  variantId: string,
  limit = 50,
  client: SelldClient = getSupabase(),
): Promise<StockMovement[]> {
  const { data, error } = await client
    .from('stock_movements')
    .select('id, delta, reason, note, reference_type, created_at, profiles(full_name)')
    .eq('variant_id', variantId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  return (data ?? []).map((row) => {
    const profile = row.profiles as { full_name: string | null } | null
    return {
      id: row.id,
      delta: row.delta,
      reason: row.reason as StockReason,
      note: row.note,
      referenceType: row.reference_type,
      createdAt: row.created_at,
      createdByName: profile?.full_name ?? null,
    }
  })
}

/** Record a relative change: "+50 received", "−2 damaged". */
export async function recordMovement(
  input: {
    tenantId: string
    variantId: string
    locationId: string
    delta: number
    reason: StockReason
    note?: string | undefined
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('record_stock_movement', {
    p_tenant_id: input.tenantId,
    p_variant_id: input.variantId,
    p_location_id: input.locationId,
    p_delta: input.delta,
    p_reason: input.reason,
    // Spread rather than passing null: the generated arg is an optional string and
    // the SQL default is already null, so omitting it is equivalent.
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

/**
 * Set an absolute count, as a stock-take does.
 *
 * The database writes the *difference* as a movement rather than overwriting the
 * total, so the ledger still explains how the number got there.
 */
export async function setStockLevel(
  input: {
    tenantId: string
    variantId: string
    locationId: string
    onHand: number
    note?: string | undefined
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('set_stock_level', {
    p_tenant_id: input.tenantId,
    p_variant_id: input.variantId,
    p_location_id: input.locationId,
    p_on_hand: input.onHand,
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

/**
 * Low-stock threshold. This is the one inventory column a seller edits directly —
 * it is a preference, not a derived quantity, so no ledger entry applies.
 */
export async function setLowStockThreshold(
  inventoryLevelId: string,
  threshold: number | null,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client
    .from('inventory_levels')
    .update({ low_stock_threshold: threshold })
    .eq('id', inventoryLevelId)
  if (error) throw error
}

export async function fetchLocations(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  const { data, error } = await client
    .from('locations')
    .select('id, name, is_default')
    .eq('tenant_id', tenantId)
    .order('is_default', { ascending: false })
    .order('name')

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
  }))
}

/** Count of low-stock rows, for the dashboard badge. */
export async function countLowStock(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<number> {
  const { count, error } = await client
    .from('inventory_overview')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_low', true)

  if (error) throw error
  return count ?? 0
}

/**
 * Turn a database error into something a seller can act on.
 *
 * The insufficient-stock case is a *business* outcome, not a fault, and it is the
 * one that will actually happen during a live selling rush.
 */
export function describeStockError(error: unknown): 'insufficient_stock' | 'not_allowed' | 'other' {
  if (!(error instanceof Error)) return 'other'
  const message = error.message.toLowerCase()
  if (message.includes('insufficient stock')) return 'insufficient_stock'
  if (message.includes('not allowed') || message.includes('permission')) return 'not_allowed'
  // The no-oversell CHECK, if a future path bypasses the RPC.
  if (message.includes('inventory_no_oversell')) return 'insufficient_stock'
  return 'other'
}
