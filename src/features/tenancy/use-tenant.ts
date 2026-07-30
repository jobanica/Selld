import { useContext } from 'react'

import type { TenantSummary } from '@/features/tenancy/tenancy-api'
import { TenantContext, type TenantContextValue } from '@/features/tenancy/tenant-context'

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error('useTenant() must be used inside a <TenantProvider>')
  }
  return context
}

/** The active tenant, or throw. For routes already behind the tenant guard. */
export function useActiveTenant(): TenantSummary {
  const { activeTenant } = useTenant()
  if (!activeTenant) {
    throw new Error('useActiveTenant() called with no active tenant')
  }
  return activeTenant
}
