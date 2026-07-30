import type { UseQueryResult } from '@tanstack/react-query'
import { createContext } from 'react'

import type { TenantRole } from '@/core/tenancy'
import type { TenantSummary } from '@/features/tenancy/tenancy-api'

export const ACTIVE_TENANT_STORAGE_KEY = 'selld.activeTenantId'

export interface TenantContextValue {
  tenants: TenantSummary[]
  activeTenant: TenantSummary | null
  setActiveTenant: (tenantId: string) => void
  /** `true` while memberships are still loading. */
  isLoading: boolean
  error: unknown
  refetch: UseQueryResult<TenantSummary[]>['refetch']
  /** Role check for the active tenant: `can('admin')` means "at least admin". */
  can: (minRole: TenantRole) => boolean
}

export const TenantContext = createContext<TenantContextValue | null>(null)
