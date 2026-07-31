import { parseCustomerFile, type ParsedCustomerFile } from '@/core/crm/import'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Customers, seller side.
 *
 * Every read is one RPC returning one document, for the reason every other
 * screen in this codebase does it: a customer list with a per-row tag query is
 * fifty queries, and a seller on mobile data notices.
 *
 * The segment definition is a plain object with a closed set of keys. It is sent
 * as JSON and evaluated by `customer_segment_match` in SQL — nothing here builds
 * a query, and nothing in the database turns this into query text.
 */

export interface SegmentDefinition {
  spentAtLeast?: number | null
  spentAtMost?: number | null
  ordersAtLeast?: number | null
  ordersAtMost?: number | null
  orderedWithinDays?: number | null
  notOrderedForDays?: number | null
  boughtCategoryId?: string | null
  boughtProductId?: string | null
  cityCode?: string | null
  rts?: 'none' | 'some' | 'any' | null
  hasTagId?: string | null
  source?: string | null
}

/** Drop the keys the seller left blank: an absent key means "do not narrow". */
export function tidyDefinition(definition: SegmentDefinition): SegmentDefinition {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(definition)) {
    if (value === null || value === undefined || value === '') continue
    out[key] = value
  }
  return out as SegmentDefinition
}

export interface CustomerRow {
  id: string
  name: string
  phone: string
  email: string | null
  orders: number
  delivered: number
  rts: number
  spent: number
  pending: number
  lastOrderAt: string | null
  source: string
  tags: { id: string; name: string; colour: string }[]
}

export interface CustomerList {
  total: number
  customers: CustomerRow[]
}

export async function fetchCustomers(
  input: { tenantId: string; search: string; sort: string },
  client: SelldClient = getSupabase(),
): Promise<CustomerList> {
  const { data, error } = await client.rpc('customers_list', {
    p_tenant_id: input.tenantId,
    p_search: input.search,
    p_sort: input.sort,
    p_limit: 50,
    p_offset: 0,
  })
  if (error) throw error
  return data as unknown as CustomerList
}

export interface CustomerProfile {
  id: string
  name: string
  phone: string
  email: string | null
  source: string
  notes: string | null
  fbPsid: string | null
  createdAt: string
  stats: {
    orders: number
    delivered: number
    rts: number
    cancelled: number
    spent: number
    pending: number
    firstOrderAt: string | null
    lastOrderAt: string | null
    rtsRateBps: number
  }
  tags: { id: string; name: string; colour: string }[]
  addresses: {
    id: string
    label: string | null
    recipient: string
    street: string
    cityName: string | null
    barangayName: string | null
    isDefault: boolean
  }[]
  orders: {
    id: string
    number: string
    placedAt: string
    total: number
    paymentStatus: string
    fulfillmentStatus: string
    source: string
    items: { name: string; qty: number }[]
  }[]
}

export async function fetchProfile(
  customerId: string,
  client: SelldClient = getSupabase(),
): Promise<CustomerProfile | null> {
  const { data, error } = await client.rpc('customer_profile', { p_customer_id: customerId })
  if (error) throw error
  return data as unknown as CustomerProfile | null
}

export interface SegmentPreview {
  total: number
  customers: CustomerRow[]
}

export async function previewSegment(
  input: { tenantId: string; definition: SegmentDefinition },
  client: SelldClient = getSupabase(),
): Promise<SegmentPreview> {
  const { data, error } = await client.rpc('customer_segment_preview', {
    p_tenant_id: input.tenantId,
    p_definition: tidyDefinition(input.definition) as never,
    p_limit: 25,
    p_offset: 0,
  })
  if (error) throw error
  return data as unknown as SegmentPreview
}

export interface SavedSegment {
  id: string
  name: string
  description: string | null
  definition: SegmentDefinition
  isPinned: boolean
  count: number
  updatedAt: string
}

export async function fetchSegments(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<SavedSegment[]> {
  const { data, error } = await client.rpc('customer_segments_list', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as SavedSegment[]
}

export async function saveSegment(
  input: {
    tenantId: string
    id: string | null
    name: string
    definition: SegmentDefinition
    description?: string | null
    pinned?: boolean
  },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client.rpc('customer_segment_save', {
    p_tenant_id: input.tenantId,
    p_name: input.name,
    p_definition: tidyDefinition(input.definition) as never,
    // Omitted rather than sent as null when absent. The generated types model an
    // optional argument as `string | undefined`, and these have no overloads, so
    // leaving a key out is the same call — unlike the PGRST202 trap, which only
    // bites when two functions share a name.
    ...(input.id === null ? {} : { p_id: input.id }),
    ...(input.description == null ? {} : { p_description: input.description }),
    p_pinned: input.pinned ?? false,
  })
  if (error) throw error
  return data as unknown as string
}

export async function deleteSegment(
  id: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('customer_segments').delete().eq('id', id)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
export interface CustomerTag {
  id: string
  name: string
  colour: string
}

export async function fetchTags(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<CustomerTag[]> {
  const { data, error } = await client
    .from('customer_tags')
    .select('id, name, colour')
    .eq('tenant_id', tenantId)
    .order('name')
  if (error) throw error
  return (data ?? []) as CustomerTag[]
}

export async function tagCustomer(
  input: { tenantId: string; customerId: string; name: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { data: tag, error: tagError } = await client
    .from('customer_tags')
    .upsert({ tenant_id: input.tenantId, name: input.name.trim() }, { onConflict: 'tenant_id,name' })
    .select('id')
    .single()
  if (tagError) throw tagError

  const { error } = await client.from('customer_tag_assignments').insert({
    tenant_id: input.tenantId,
    customer_id: input.customerId,
    tag_id: (tag as { id: string }).id,
  })
  if (error) throw error
}

export async function untagCustomer(
  input: { customerId: string; tagId: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client
    .from('customer_tag_assignments')
    .delete()
    .eq('customer_id', input.customerId)
    .eq('tag_id', input.tagId)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Import and merge
// ---------------------------------------------------------------------------
export interface ImportResult {
  created: number
  updated: number
  invalid: number
  duplicatesInFile: number
}

/**
 * Read the file in the browser, then hand the *rows* to the database.
 *
 * The parse is a heuristic over somebody else's spreadsheet, so it belongs where
 * it can be shown to the seller before anything is written — "we read 397 people
 * out of this, here are the three we could not" is a confirmation step, not an
 * error message after the fact. What crosses into SQL is a list of names and
 * numbers, and `customers_import` decides which of them are new.
 */
export async function importCustomers(
  input: { tenantId: string; file: File; tagName: string | null },
  client: SelldClient = getSupabase(),
): Promise<{ parsed: ParsedCustomerFile; result: ImportResult }> {
  const parsed = await parseCustomerFile(await input.file.arrayBuffer())

  const { data, error } = await client.rpc('customers_import', {
    p_tenant_id: input.tenantId,
    p_rows: parsed.rows as never,
    p_source: 'import',
    ...(input.tagName === null ? {} : { p_tag_name: input.tagName }),
  })
  if (error) throw error

  return { parsed, result: data as unknown as ImportResult }
}

export async function mergeCustomers(
  input: { keepId: string; mergeId: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('customers_merge', {
    p_keep_id: input.keepId,
    p_merge_id: input.mergeId,
  })
  if (error) throw error
}

export function describeCustomerError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('customer_stats_readonly')) return 'customers.errorStatsReadonly'
  if (message.includes('merged into themselves')) return 'customers.errorMergeSelf'
  if (message.includes('customer_segments_tenant_id_name_key')) return 'customers.errorDuplicateName'
  if (message.includes('no_header')) return 'customers.errorNoHeader'
  if (message.includes('no_phone_column')) return 'customers.errorNoPhoneColumn'
  if (message.includes('empty')) return 'customers.errorEmptyFile'
  if (message.includes('Not allowed')) return 'customers.errorNotAllowed'
  return 'customers.errorUnknown'
}
