import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { hasAtLeastRole, type TenantRole } from '@/core/tenancy'
import { useSession } from '@/features/auth/use-session'
import { fetchMyTenants, type TenantSummary } from '@/features/tenancy/tenancy-api'
import {
  ACTIVE_TENANT_STORAGE_KEY,
  TenantContext,
  type TenantContextValue,
} from '@/features/tenancy/tenant-context'

/** Stable empty array so an unresolved query does not invalidate memos each render. */
const NO_TENANTS: TenantSummary[] = []

function readStoredTenantId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistTenantId(tenantId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, tenantId)
  } catch {
    // Private browsing — selection still applies for this session.
  }
}

/**
 * The active tenant for the dashboard.
 *
 * Resolution order: an explicit choice this session, then the last choice
 * persisted from a previous session, then the first membership. The persisted id
 * is validated against the memberships the server actually returned, so a stale
 * id (access revoked, tenant deleted) degrades to the first available tenant
 * instead of leaving the dashboard wedged on a tenant that no longer resolves.
 *
 * Note this is a **UI preference only**. It never widens what the seller can
 * read — `my_tenants()` and RLS decide that. Tampering with the stored id gets
 * you, at worst, one of your own tenants.
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { status, user } = useSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['my-tenants', user?.id],
    queryFn: () => fetchMyTenants(),
    enabled: status === 'authenticated',
    staleTime: 60_000,
  })

  const tenants = query.data ?? NO_TENANTS

  const activeTenant = useMemo(() => {
    if (tenants.length === 0) return null

    for (const candidate of [selectedId, readStoredTenantId()]) {
      if (candidate === null) continue
      const match = tenants.find((tenant) => tenant.id === candidate)
      if (match) return match
    }
    return tenants[0] ?? null
  }, [selectedId, tenants])

  const setActiveTenant = useCallback((tenantId: string) => {
    setSelectedId(tenantId)
    persistTenantId(tenantId)
  }, [])

  const can = useCallback(
    (minRole: TenantRole) => (activeTenant ? hasAtLeastRole(activeTenant.role, minRole) : false),
    [activeTenant],
  )

  const { isLoading, error, refetch } = query

  const value = useMemo<TenantContextValue>(
    () => ({
      tenants,
      activeTenant,
      setActiveTenant,
      isLoading: status === 'loading' || isLoading,
      error,
      refetch,
      can,
    }),
    [tenants, activeTenant, setActiveTenant, status, isLoading, error, refetch, can],
  )

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}
