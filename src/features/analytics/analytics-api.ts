import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Analytics and true profit, seller side.
 *
 * Four RPCs rather than one, because they answer four questions at four
 * cadences: the profit number is what the seller came for and must paint first;
 * the breakdown and the trend are what they read next; the ad-spend list is only
 * needed when they open the drawer to correct a figure.
 *
 * None of this arithmetic happens here. A profit figure computed in the browser
 * is a profit figure that can disagree with the one in a support conversation,
 * and every input to it — cost snapshots, courier charges, payment fees — is
 * already in the database.
 */

export interface ProfitCosts {
  cogs: number
  shipping: number
  codFees: number
  paymentFees: number
  platformFees: number
  returns: number
  ads: number
  subscription: number
}

export interface Profit {
  from: string
  to: string
  revenue: number
  orders: number
  units: number
  aov: number
  inFlight: number
  costs: ProfitCosts
  profit: number
  grossMargin: number
  returns: { orders: number; cost: number }
  coverage: {
    costedRevenue: number
    itemRevenue: number
    costedFraction: number
    itemsWithoutCost: number
    shipmentsWithoutCost: number
  }
}

export interface CommissionKept {
  bps: number
  directRevenue: number
  kept: number
  paidToMarketplaces: number
}

export interface Breakdown {
  byChannel: { channel: string; orders: number; revenue: number; aov: number }[]
  byCity: { city: string; orders: number; revenue: number }[]
  byProduct: {
    productName: string
    sku: string | null
    units: number
    revenue: number
    cost: number
    margin: number
    marginPct: number
    costKnown: boolean
  }[]
  uncosted: { productName: string; units: number; revenue: number }[]
  worstProduct: {
    productName: string
    units: number
    revenue: number
    margin: number
    marginPct: number
  } | null
}

export interface TrendMonth {
  month: string
  revenue: number
  orders: number
  rtsRate: number | null
  rtsOrders: number
  decidedOrders: number
  cohortSize: number
  cohortRepeatRate: number | null
}

/** `null` on either bound means "this Manila month, so far". */
export interface Window {
  from?: string | null
  to?: string | null
}

const windowArgs = (range: Window): Record<string, string> => ({
  ...(range.from == null ? {} : { p_from: range.from }),
  ...(range.to == null ? {} : { p_to: range.to }),
})

export async function fetchProfit(
  tenantId: string,
  range: Window = {},
  client: SelldClient = getSupabase(),
): Promise<Profit> {
  const { data, error } = await client.rpc('analytics_profit', {
    p_tenant_id: tenantId,
    ...windowArgs(range),
  })
  if (error) throw error
  return data as unknown as Profit
}

export async function fetchCommissionKept(
  tenantId: string,
  range: Window = {},
  client: SelldClient = getSupabase(),
): Promise<CommissionKept> {
  const { data, error } = await client.rpc('analytics_commission_kept', {
    p_tenant_id: tenantId,
    ...windowArgs(range),
  })
  if (error) throw error
  return data as unknown as CommissionKept
}

export async function fetchBreakdown(
  tenantId: string,
  range: Window = {},
  client: SelldClient = getSupabase(),
): Promise<Breakdown> {
  const { data, error } = await client.rpc('analytics_breakdown', {
    p_tenant_id: tenantId,
    ...windowArgs(range),
  })
  if (error) throw error
  return data as unknown as Breakdown
}

export async function fetchTrends(
  tenantId: string,
  months = 6,
  client: SelldClient = getSupabase(),
): Promise<TrendMonth[]> {
  const { data, error } = await client.rpc('analytics_trends', {
    p_tenant_id: tenantId,
    p_months: months,
  })
  if (error) throw error
  return (data ?? []) as unknown as TrendMonth[]
}

export interface AdSpendRow {
  id: string
  spentOn: string
  channel: string
  amount: number
  note: string | null
}

export async function fetchAdSpend(
  tenantId: string,
  range: Window = {},
  client: SelldClient = getSupabase(),
): Promise<AdSpendRow[]> {
  const { data, error } = await client.rpc('ad_spend_list', {
    p_tenant_id: tenantId,
    ...windowArgs(range),
  })
  if (error) throw error
  return (data ?? []) as unknown as AdSpendRow[]
}

export async function recordAdSpend(
  input: {
    tenantId: string
    spentOn: string
    /** Pesos as typed. Converted to centavos here, once. */
    pesos: number
    channel: string
    note?: string
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('ad_spend_record', {
    p_tenant_id: input.tenantId,
    p_spent_on: input.spentOn,
    // Integer arithmetic on the way in, per hard rule 2, so nothing downstream
    // has to guess which unit it is holding.
    p_amount: Math.round(input.pesos) * 100,
    p_channel: input.channel,
    ...(input.note === undefined ? {} : { p_note: input.note }),
  })
  if (error) throw error
}

export function describeAnalyticsError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('not_allowed') || message.includes('Not allowed'))
    return 'analytics.errorNotAllowed'
  return 'analytics.errorUnknown'
}
