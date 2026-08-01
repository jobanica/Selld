import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Super admin and white-label, client side.
 *
 * Every function here is granted to `authenticated` and checks
 * `is_platform_admin()` or `reseller_require()` *inside itself*. The grant is what
 * makes the call reachable; it is not the boundary. Hiding the nav item is a
 * courtesy to the 99.9% of users it does not apply to and is worth nothing as
 * security — this whole file is one `curl` away for anybody who reads the bundle.
 */

export interface PlatformRoles {
  isPlatformAdmin: boolean
  platformRole: 'owner' | 'support' | 'billing' | null
  reseller: {
    id: string
    name: string
    slug: string
    role: 'owner' | 'admin' | 'support'
    brandName: string
  } | null
}

export async function fetchPlatformRoles(
  client: SelldClient = getSupabase(),
): Promise<PlatformRoles> {
  const { data, error } = await client.rpc('my_platform_roles')
  if (error) throw error
  return data as unknown as PlatformRoles
}

export interface PlatformOverview {
  mrrCentavos: number
  stores: {
    total: number
    trialing: number
    active: number
    pastDue: number
    restricted: number
    cancelled: number
    new30d: number
  }
  churn: { base: number; lost: number; rate: number | null }
  collected30dCentavos: number
  overdueCentavos: number
  resellers: number
  resellerStores: number
}

export async function fetchPlatformOverview(
  client: SelldClient = getSupabase(),
): Promise<PlatformOverview> {
  const { data, error } = await client.rpc('platform_overview')
  if (error) throw error
  return data as unknown as PlatformOverview
}

export interface PlatformTenant {
  tenantId: string
  name: string
  slug: string
  createdAt: string
  status: string | null
  planName: string | null
  priceCentavos: number | null
  currentPeriodEnd: string | null
  reseller: string | null
  orders: number
  products: number
  users: number
}

export async function fetchPlatformTenants(
  search: string,
  client: SelldClient = getSupabase(),
): Promise<PlatformTenant[]> {
  const { data, error } = await client.rpc('platform_tenants', {
    ...(search.trim() === '' ? {} : { p_search: search.trim() }),
  })
  if (error) throw error
  return (data ?? []) as unknown as PlatformTenant[]
}

export interface ImpersonationRow {
  id: string
  tenantId: string
  tenantName: string
  actorEmail: string | null
  reason: string
  actorKind: 'platform' | 'reseller'
  startedAt: string
  endedAt: string | null
  expiresAt: string
}

export async function fetchImpersonationLog(
  client: SelldClient = getSupabase(),
): Promise<ImpersonationRow[]> {
  const { data, error } = await client.rpc('platform_impersonation_log', { p_limit: 100 })
  if (error) throw error
  return (data ?? []) as unknown as ImpersonationRow[]
}

export async function setPlanOverride(
  input: { tenantId: string; planId: string; status?: string; note: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('platform_set_plan', {
    p_tenant_id: input.tenantId,
    p_plan_id: input.planId,
    p_note: input.note,
    ...(input.status === undefined ? {} : { p_status: input.status }),
  })
  if (error) throw error
}

export async function announce(
  input: { title: string; body: string; level?: string; resellerId?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('platform_announce', {
    p_title: input.title,
    p_body: input.body,
    ...(input.level === undefined ? {} : { p_level: input.level }),
    ...(input.resellerId === undefined ? {} : { p_reseller_id: input.resellerId }),
  })
  if (error) throw error
}

export async function createReseller(
  input: { name: string; slug: string; ownerEmail: string; commissionBps: number },
  client: SelldClient = getSupabase(),
): Promise<{ resellerId: string; slug: string; ownerLinked: boolean }> {
  const { data, error } = await client.rpc('platform_create_reseller', {
    p_name: input.name,
    p_slug: input.slug,
    p_owner_email: input.ownerEmail,
    p_commission_bps: input.commissionBps,
  })
  if (error) throw error
  return data as unknown as { resellerId: string; slug: string; ownerLinked: boolean }
}

// ---------------------------------------------------------------------------
// Reseller
// ---------------------------------------------------------------------------
export interface ResellerSeller {
  tenantId: string
  name: string
  slug: string
  status: string | null
  planName: string | null
  priceCentavos: number | null
  currentPeriodEnd: string | null
  orders: number
  createdAt: string
}

export interface ResellerOverview {
  reseller: {
    id: string
    name: string
    slug: string
    brandName: string | null
    brandColor: string | null
    supportEmail: string | null
    commissionBps: number
  }
  mrrCentavos: number
  sellers: ResellerSeller[]
  plans: {
    id: string
    code: string
    name: string
    priceCentavos: number
    limits: Record<string, unknown>
    sellers: number
  }[]
}

export async function fetchResellerOverview(
  client: SelldClient = getSupabase(),
): Promise<ResellerOverview> {
  const { data, error } = await client.rpc('reseller_overview')
  if (error) throw error
  return data as unknown as ResellerOverview
}

export interface RevenueSplit {
  from: string
  to: string
  invoices: number
  grossCentavos: number
  platformCutCentavos: number
  netCentavos: number
  byMonth: {
    month: string
    grossCentavos: number
    platformCutCentavos: number
    netCentavos: number
  }[]
}

export async function fetchRevenueSplit(
  range: { from?: string; to?: string } = {},
  client: SelldClient = getSupabase(),
): Promise<RevenueSplit> {
  const { data, error } = await client.rpc('reseller_revenue_split', {
    ...(range.from === undefined ? {} : { p_from: range.from }),
    ...(range.to === undefined ? {} : { p_to: range.to }),
  })
  if (error) throw error
  return data as unknown as RevenueSplit
}

export async function upsertResellerPlan(
  input: {
    code: string
    name: string
    priceCentavos: number
    maxProducts: number | null
    maxUsers: number | null
    features: string[]
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('reseller_plan_upsert', {
    p_code: input.code,
    p_name: input.name,
    p_price_centavos: input.priceCentavos,
    p_limits: {
      maxProducts: input.maxProducts,
      maxUsers: input.maxUsers,
      features: input.features,
    },
  })
  if (error) throw error
}

export interface CreatedSeller {
  tenantId: string
  slug: string
  name: string
  planName: string
  priceCentavos: number
  ownerEmail: string
  invitationToken: string
}

/**
 * Onboard a seller. The done-when of phase 19, in one call.
 *
 * The invitation token comes back so the reseller can deliver the link — see the
 * note on `reseller_create_tenant` in the migration for why that is a deliberate
 * exception to "tokens never leave the database".
 */
export async function createSellerTenant(
  input: {
    name: string
    slug: string
    ownerEmail: string
    planId: string
    priceCentavos?: number
  },
  client: SelldClient = getSupabase(),
): Promise<CreatedSeller> {
  const { data, error } = await client.rpc('reseller_create_tenant', {
    p_name: input.name,
    p_slug: input.slug,
    p_owner_email: input.ownerEmail,
    p_plan_id: input.planId,
    ...(input.priceCentavos === undefined ? {} : { p_price_centavos: input.priceCentavos }),
  })
  if (error) throw error
  return data as unknown as CreatedSeller
}

export async function setSellerPrice(
  input: { tenantId: string; priceCentavos: number },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('reseller_set_price', {
    p_tenant_id: input.tenantId,
    p_price_centavos: input.priceCentavos,
  })
  if (error) throw error
}

export async function setResellerBranding(
  input: { brandName?: string; brandColor?: string; supportEmail?: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('reseller_set_branding', {
    ...(input.brandName === undefined ? {} : { p_brand_name: input.brandName }),
    ...(input.brandColor === undefined ? {} : { p_brand_color: input.brandColor }),
    ...(input.supportEmail === undefined ? {} : { p_support_email: input.supportEmail }),
  })
  if (error) throw error
}

export function describePlatformError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('reason_required')) return 'platform.errorReasonRequired'
  if (message.includes('invalid_slug')) return 'platform.errorInvalidSlug'
  if (message.includes('invalid_email')) return 'platform.errorInvalidEmail'
  if (message.includes('plan_not_yours')) return 'platform.errorPlanNotYours'
  if (message.includes('duplicate key') || message.includes('already exists')) {
    return 'platform.errorDuplicate'
  }
  if (message.includes('Not allowed') || message.includes('insufficient_privilege')) {
    return 'platform.errorNotAllowed'
  }
  return 'platform.errorUnknown'
}
