import { fromDb, type Centavos } from '@/lib/money'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Orders, seller side.
 *
 * Every read here is one RPC returning one jsonb document, matching the storefront's
 * discipline for the same reason: a seller on provincial mobile data pays a full
 * latency per round trip, and an order screen that fans out into six queries is six
 * of them before anything is readable.
 */

export const ORDER_VIEWS = [
  'needs_confirmation',
  'to_pack',
  'to_ship',
  'in_transit',
  'rts',
  'today_cod',
  'all',
] as const

export type OrderView = (typeof ORDER_VIEWS)[number]

export type FulfillmentStatus =
  | 'pending'
  | 'confirmed'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'rts'
  | 'cancelled'

export interface OrderRow {
  id: string
  orderNumber: string
  placedAt: string
  contactName: string
  contactPhone: string
  city: string | null
  province: string | null
  paymentMethod: string
  paymentStatus: string
  fulfillmentStatus: FulfillmentStatus
  grandTotal: Centavos
  itemCount: number
  source: string
}

export type ViewCounts = Record<OrderView, number>

export interface OrderListPage {
  view: OrderView
  orders: OrderRow[]
  counts: ViewCounts
}

export interface OrderCursor {
  placedAt: string
  id: string
}

interface RawOrderRow extends Omit<OrderRow, 'grandTotal'> {
  grandTotal: number
}

function toOrderRow(raw: RawOrderRow): OrderRow {
  return { ...raw, grandTotal: fromDb(raw.grandTotal) }
}

export async function fetchOrders(
  input: {
    tenantId: string
    view: OrderView
    search?: string
    limit?: number
    cursor?: OrderCursor
  },
  client: SelldClient = getSupabase(),
): Promise<OrderListPage> {
  const { data, error } = await client.rpc('orders_list', {
    p_tenant_id: input.tenantId,
    p_view: input.view,
    ...(input.search === undefined || input.search === '' ? {} : { p_search: input.search }),
    p_limit: input.limit ?? 50,
    ...(input.cursor === undefined
      ? {}
      : { p_before_placed_at: input.cursor.placedAt, p_before_id: input.cursor.id }),
  })
  if (error) throw error

  const page = (data ?? {}) as { view?: OrderView; orders?: RawOrderRow[]; counts?: ViewCounts }
  return {
    view: page.view ?? input.view,
    orders: (page.orders ?? []).map(toOrderRow),
    counts: page.counts ?? ({} as ViewCounts),
  }
}

export interface OrderDetail {
  id: string
  orderNumber: string
  placedAt: string
  source: string
  contactName: string
  contactPhone: string
  contactEmail: string | null
  address: Record<string, string | null>
  buyerNote: string | null
  paymentMethod: string
  paymentStatus: string
  fulfillmentStatus: FulfillmentStatus
  cancelledReason: string | null
  subtotal: Centavos
  discountTotal: Centavos
  shippingTotal: Centavos
  codFee: Centavos
  grandTotal: Centavos
  items: {
    id: string
    productName: string
    variantLabel: string | null
    sku: string | null
    qty: number
    unitPrice: Centavos
    lineTotal: Centavos
  }[]
  payments: {
    id: string
    provider: string
    method: string
    status: string
    amount: Centavos
    fee: Centavos | null
    refunded: Centavos
    providerRef: string | null
    proofPath: string | null
    proofNote: string | null
    paidAt: string | null
    createdAt: string
  }[]
  timeline: {
    id: string
    field: string
    fromStatus: string | null
    toStatus: string
    note: string | null
    actorName: string | null
    createdAt: string
  }[]
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[]
  shipments: unknown[]
  /** What this order may legally move to. Read from the database, never guessed. */
  allowedTransitions: FulfillmentStatus[]
}

export async function fetchOrderDetail(
  orderId: string,
  client: SelldClient = getSupabase(),
): Promise<OrderDetail | null> {
  const { data, error } = await client.rpc('order_detail', { p_order_id: orderId })
  if (error) throw error
  if (data === null) return null

  const raw = data as unknown as Record<string, unknown>
  const money = (value: unknown): Centavos => fromDb(value as number)

  return {
    ...(raw as unknown as OrderDetail),
    subtotal: money(raw['subtotal']),
    discountTotal: money(raw['discountTotal']),
    shippingTotal: money(raw['shippingTotal']),
    codFee: money(raw['codFee']),
    grandTotal: money(raw['grandTotal']),
    items: ((raw['items'] ?? []) as Record<string, unknown>[]).map((item) => ({
      ...(item as unknown as OrderDetail['items'][number]),
      unitPrice: money(item['unitPrice']),
      lineTotal: money(item['lineTotal']),
    })),
    payments: ((raw['payments'] ?? []) as Record<string, unknown>[]).map((payment) => ({
      ...(payment as unknown as OrderDetail['payments'][number]),
      amount: money(payment['amount']),
      fee: payment['fee'] === null ? null : money(payment['fee']),
      refunded: money(payment['refunded']),
    })),
  }
}

export interface BulkResult {
  moved: number
  skipped: number
  orderIds: string[]
}

/**
 * Move a batch of orders in one round trip.
 *
 * This is the phase's done-when: 50 orders from `confirmed` to `packed` in under 60
 * seconds. One call for the whole batch, not one per order — fifty RPCs at a
 * provincial 150ms RTT would be 7.5 seconds of pure latency, and fifty separate
 * transactions, so a dropped connection halfway would leave the seller unable to
 * tell which half moved.
 */
export async function bulkTransition(
  input: { tenantId: string; orderIds: string[]; toStatus: FulfillmentStatus; note?: string },
  client: SelldClient = getSupabase(),
): Promise<BulkResult> {
  const { data, error } = await client.rpc('orders_bulk_transition', {
    p_tenant_id: input.tenantId,
    p_order_ids: input.orderIds,
    p_to_status: input.toStatus,
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
  return (data ?? { moved: 0, skipped: 0, orderIds: [] }) as unknown as BulkResult
}

export async function addOrderNote(
  input: { orderId: string; body: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('add_order_note', {
    p_order_id: input.orderId,
    p_body: input.body,
  })
  if (error) throw error
}

export interface PackingBatch {
  store: { name: string; slug: string }
  orders: {
    id: string
    orderNumber: string
    placedAt: string
    contactName: string
    contactPhone: string
    address: Record<string, string | null>
    buyerNote: string | null
    paymentMethod: string
    paymentStatus: string
    grandTotal: Centavos
    codDue: Centavos
    items: { productName: string; variantLabel: string | null; sku: string | null; qty: number }[]
  }[]
  pickingList: {
    productName: string
    variantLabel: string | null
    sku: string | null
    qty: number
  }[]
}

export async function fetchPackingBatch(
  input: { tenantId: string; orderIds: string[] },
  client: SelldClient = getSupabase(),
): Promise<PackingBatch | null> {
  const { data, error } = await client.rpc('orders_packing_batch', {
    p_tenant_id: input.tenantId,
    p_order_ids: input.orderIds,
  })
  if (error) throw error
  if (data === null) return null

  const raw = data as unknown as PackingBatch
  return {
    ...raw,
    orders: raw.orders.map((order) => ({
      ...order,
      grandTotal: fromDb(order.grandTotal),
      codDue: fromDb(order.codDue),
    })),
  }
}

export async function createManualOrder(
  input: {
    tenantId: string
    contactName: string
    contactPhone: string
    address: Record<string, string | null>
    items: { variantId: string; qty: number }[]
    paymentMethod?: string
    notes?: string
  },
  client: SelldClient = getSupabase(),
): Promise<{ id: string; orderNumber: string }> {
  const { data, error } = await client.rpc('create_manual_order', {
    p_tenant_id: input.tenantId,
    p_contact_name: input.contactName,
    p_contact_phone: input.contactPhone,
    p_address: input.address,
    p_items: input.items,
    p_payment_method: input.paymentMethod ?? 'cod',
    ...(input.notes === undefined ? {} : { p_notes: input.notes }),
  })
  if (error) throw error
  return data as unknown as { id: string; orderNumber: string }
}

/**
 * Turn a failure into something a seller can act on.
 *
 * `errorMessage`, not `error instanceof Error`: PostgREST returns a plain object on
 * the ordinary path, and an instanceof guard sends every case to `unknown`. That
 * shipped twice already — see src/lib/supabase/errors.ts.
 */
export function describeOrderError(error: unknown): string {
  const message = errorMessage(error).toLowerCase()
  if (message === '') return 'unknown'
  if (message.includes('max 500')) return 'batch_too_large'
  if (message.includes('insufficient stock')) return 'stock'
  if (message.includes('empty_cart')) return 'empty'
  if (message.includes('address_incomplete')) return 'address'
  if (message.includes('contact_phone')) return 'phone'
  if (message.includes('permission') || message.includes('not allowed')) return 'not_allowed'
  return 'unknown'
}
