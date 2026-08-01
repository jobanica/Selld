import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorHint, errorMessage } from '@/lib/supabase/errors'

/**
 * Billing, the seller's side.
 *
 * Nothing here decides anything. The plan a store may move to, the price it pays,
 * whether a downgrade is allowed, what a credit pack costs — every one of those is
 * answered by a function in the database, because every one of them is a rule a
 * `curl` with the anon key would otherwise ignore. This file asks and renders.
 *
 * The one exception is `buyCredits`, which goes through the Node server: raising a
 * hosted invoice needs Selld's own gateway key, and a key that can charge cards
 * must never be in a browser bundle.
 */

export interface PlanLimits {
  maxProducts: number | null
  maxUsers: number | null
  maxOrdersPerMonth: number | null
  features: string[]
}

export interface Plan {
  id: string
  code: string
  name: string
  description: string | null
  priceCentavos: number
  intervalMonths: number
  limits: PlanLimits
}

export interface BillingInvoice {
  id: string
  amountCentavos: number
  status: 'open' | 'paid' | 'failed' | 'void'
  periodStart: string
  periodEnd: string
  checkoutUrl: string | null
  paidAt: string | null
  createdAt: string
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'restricted'
  | 'cancelled'

export interface SubscriptionOverview {
  status: SubscriptionStatus
  priceCentavos: number
  trialEndsAt: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAt: string | null
  graceEndsAt: string | null
  plan: Plan
  usage: { products: number; users: number; ordersThisMonth: number }
  smsCredits: number
  billedBy: { name: string; supportEmail: string | null } | null
  invoices: BillingInvoice[]
}

export async function fetchSubscription(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<SubscriptionOverview | null> {
  const { data, error } = await client.rpc('subscription_overview', {
    p_tenant_id: tenantId,
  })
  if (error) throw error
  return data as unknown as SubscriptionOverview | null
}

export async function fetchPlans(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<Plan[]> {
  const { data, error } = await client.rpc('subscription_plans', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as Plan[]
}

export async function changePlan(
  input: { tenantId: string; planId: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('subscription_change_plan', {
    p_tenant_id: input.tenantId,
    p_plan_id: input.planId,
  })
  if (error) throw error
}

export async function cancelSubscription(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('subscription_cancel', { p_tenant_id: tenantId })
  if (error) throw error
}

export async function resumeSubscription(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('subscription_resume', { p_tenant_id: tenantId })
  if (error) throw error
}

export interface Announcement {
  id: string
  title: string
  body: string
  level: 'info' | 'warning' | 'critical'
  startsAt: string
}

export async function fetchAnnouncements(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<Announcement[]> {
  const { data, error } = await client.rpc('announcements_active', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as unknown as Announcement[]
}

export interface ResellerBrand {
  name: string
  color: string | null
  logoPath: string | null
  supportEmail: string | null
}

export async function fetchBrand(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<ResellerBrand | null> {
  const { data, error } = await client.rpc('reseller_branding', { p_tenant_id: tenantId })
  if (error) throw error
  return data as unknown as ResellerBrand | null
}

/** The three packs `credit_pack_price()` knows about. */
export const CREDIT_PACKS = [500, 2000, 10000] as const

/**
 * Buy SMS credits.
 *
 * Through the server, not through PostgREST: the row is created by the seller's
 * own token (so `has_tenant_role` is the check) and the hosted invoice is raised
 * with Selld's platform key, which the browser never sees.
 */
export async function buyCredits(
  input: { tenantId: string; credits: number },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (token === undefined) throw new Error('not_authenticated')

  const response = await fetch(`/api/billing/${input.tenantId}/credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ credits: input.credits }),
  })
  const body = (await response.json()) as { checkoutUrl?: string; error?: string }
  if (!response.ok || body.checkoutUrl === undefined) {
    throw new Error(body.error ?? 'billing_failed')
  }
  return body.checkoutUrl
}

/**
 * A PostgREST error is a plain object, not an `Error` — see CLAUDE.md. Matching on
 * `error instanceof Error` first returns the fallback for every database failure,
 * which is how a seller gets "please try again" forever for a downgrade they could
 * actually fix by deleting two products.
 */
export function describeBillingError(error: unknown): string {
  // Hint *and* message. The hint is what the migration raises deliberately; the
  // message is the human sentence and is also where a server-route failure
  // arrives, since those are plain strings with no hint at all.
  const message = `${errorHint(error)} ${errorMessage(error)}`
  if (message.includes('downgrade_products')) return 'billing.errorDowngradeProducts'
  if (message.includes('downgrade_users')) return 'billing.errorDowngradeUsers'
  if (message.includes('plan_not_available')) return 'billing.errorPlanUnavailable'
  if (message.includes('unknown_pack')) return 'billing.errorUnknownPack'
  if (message.includes('billing_not_configured')) return 'billing.errorNotConfigured'
  if (message.includes('Not allowed') || message.includes('insufficient_privilege')) {
    return 'billing.errorNotAllowed'
  }
  return 'billing.errorUnknown'
}

/**
 * What a plan-limit rejection means, wherever it surfaces.
 *
 * Exported because these do not arrive on the billing screen — they arrive when a
 * seller presses "add product" on the catalogue screen, which is exactly where the
 * explanation has to be. A raw `check_violation` there reads as a bug in the
 * product form.
 */
export function describePlanLimitError(error: unknown): string | null {
  const message = `${errorHint(error)} ${errorMessage(error)}`
  if (message.includes('plan_limit_products')) return 'billing.limitProducts'
  if (message.includes('plan_limit_users')) return 'billing.limitUsers'
  if (message.includes('plan_limit_orders')) return 'billing.limitOrders'
  if (message.includes('plan_feature_live')) return 'billing.featureLive'
  if (message.includes('plan_feature_broadcasts')) return 'billing.featureBroadcasts'
  if (message.includes('plan_feature_marketplaces')) return 'billing.featureMarketplaces'
  if (message.includes('billing_restricted')) return 'billing.restricted'
  return null
}
