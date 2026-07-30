/**
 * Tenancy vocabulary shared by every surface.
 *
 * Roles are ordered by capability so permission checks can be written as
 * "at least staff" instead of enumerating role lists at every call site.
 */

export type TenantRole = 'owner' | 'admin' | 'staff' | 'packer' | 'rider'

/** Higher number means broader capability. */
export const ROLE_RANK: Record<TenantRole, number> = {
  rider: 10,
  packer: 20,
  staff: 30,
  admin: 40,
  owner: 50,
}

export function hasAtLeastRole(actual: TenantRole, required: TenantRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

export type TenantStatus = 'active' | 'suspended' | 'cancelled'

export type PlanCode = 'starter' | 'seller' | 'pro' | 'scale'

export interface PlanLimits {
  /** `null` means unlimited. */
  maxOrdersPerMonth: number | null
  maxProducts: number | null
  maxUsers: number | null
  features: readonly string[]
}

export interface TenantSummary {
  id: string
  name: string
  slug: string
  customDomain: string | null
  status: TenantStatus
  planCode: PlanCode
  timezone: string
  locale: string
}

export interface TenantMembership {
  tenantId: string
  userId: string
  role: TenantRole
}
