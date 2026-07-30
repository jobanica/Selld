import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionState } from '@/features/auth/session-context'
import { SessionContext } from '@/features/auth/session-context'
import { ACTIVE_TENANT_STORAGE_KEY } from '@/features/tenancy/tenant-context'
import { TenantProvider } from '@/features/tenancy/tenant-provider'
import { TenantSwitcher } from '@/features/tenancy/tenant-switcher'
import { useTenant } from '@/features/tenancy/use-tenant'
import { initI18n } from '@/lib/i18n'

import type { TenantSummary } from './tenancy-api'

const fetchMyTenants = vi.fn<() => Promise<TenantSummary[]>>()

vi.mock('@/features/tenancy/tenancy-api', () => ({
  fetchMyTenants: () => fetchMyTenants(),
}))

const RHEA: TenantSummary = {
  id: 'tenant-rhea',
  name: "Rhea's Finds",
  slug: 'rheas-finds',
  logoPath: null,
  brandColor: null,
  status: 'active',
  role: 'owner',
  joinedAt: '2026-01-01T00:00:00Z',
}

const SIDELINE: TenantSummary = {
  ...RHEA,
  id: 'tenant-sideline',
  name: 'Sideline Skincare',
  slug: 'sideline-skincare',
  role: 'staff',
}

function Harness({ children }: { children: ReactNode }) {
  const session: SessionState = {
    status: 'authenticated',
    session: null,
    user: { id: 'user-rhea' } as SessionState['user'],
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <TenantProvider>{children}</TenantProvider>
      </SessionContext.Provider>
    </QueryClientProvider>
  )
}

function Probe() {
  const { activeTenant, tenants, can } = useTenant()
  return (
    <div>
      <span data-testid="active">{activeTenant?.name ?? 'none'}</span>
      <span data-testid="count">{tenants.length}</span>
      <span data-testid="can-admin">{String(can('admin'))}</span>
      <span data-testid="can-packer">{String(can('packer'))}</span>
    </div>
  )
}

describe('TenantProvider', () => {
  beforeEach(() => {
    initI18n('en')
    window.localStorage.clear()
    fetchMyTenants.mockReset()
  })

  it('defaults to the first membership', async () => {
    fetchMyTenants.mockResolvedValue([RHEA, SIDELINE])
    render(
      <Harness>
        <Probe />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent("Rhea's Finds"))
    expect(screen.getByTestId('count')).toHaveTextContent('2')
  })

  it('restores the tenant persisted from a previous session', async () => {
    window.localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, SIDELINE.id)
    fetchMyTenants.mockResolvedValue([RHEA, SIDELINE])
    render(
      <Harness>
        <Probe />
      </Harness>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Sideline Skincare'),
    )
  })

  it('ignores a stale stored id instead of wedging the dashboard', async () => {
    // Access revoked, or the tenant was deleted since last visit.
    window.localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, 'tenant-that-no-longer-exists')
    fetchMyTenants.mockResolvedValue([RHEA])
    render(
      <Harness>
        <Probe />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent("Rhea's Finds"))
  })

  it('reports no active tenant when the user belongs to none', async () => {
    fetchMyTenants.mockResolvedValue([])
    render(
      <Harness>
        <Probe />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'))
    expect(screen.getByTestId('active')).toHaveTextContent('none')
    // With no tenant, every capability check is false — never accidentally true.
    expect(screen.getByTestId('can-packer')).toHaveTextContent('false')
  })

  it('derives capabilities from the active tenant role', async () => {
    fetchMyTenants.mockResolvedValue([SIDELINE]) // staff
    render(
      <Harness>
        <Probe />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent('Sideline'))
    // staff outranks packer but not admin.
    expect(screen.getByTestId('can-packer')).toHaveTextContent('true')
    expect(screen.getByTestId('can-admin')).toHaveTextContent('false')
  })
})

describe('TenantSwitcher', () => {
  beforeEach(() => {
    initI18n('en')
    window.localStorage.clear()
    fetchMyTenants.mockReset()
  })

  it('renders plain text when there is only one store', async () => {
    fetchMyTenants.mockResolvedValue([RHEA])
    render(
      <Harness>
        <TenantSwitcher />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByText("Rhea's Finds")).toBeInTheDocument())
    // A dropdown with one option would cost a tap for nothing.
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument()
  })

  it('switches tenants and persists the choice', async () => {
    const user = userEvent.setup()
    fetchMyTenants.mockResolvedValue([RHEA, SIDELINE])
    render(
      <Harness>
        <TenantSwitcher />
        <Probe />
      </Harness>,
    )

    await waitFor(() => expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument())
    await user.click(screen.getByTestId('tenant-switcher'))
    await user.click(await screen.findByRole('menuitem', { name: /Sideline Skincare/ }))

    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('Sideline Skincare'),
    )
    expect(window.localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY)).toBe(SIDELINE.id)
  })
})
