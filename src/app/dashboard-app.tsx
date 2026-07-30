import { Route, Routes } from 'react-router-dom'

import { DashboardLayout } from '@/app/dashboard-layout'
import { ALL_NAV_ITEMS } from '@/app/navigation'
import { ComingSoon } from '@/app/pages/coming-soon'
import { DashboardHome } from '@/app/pages/dashboard-home'
import { NotFound } from '@/app/pages/not-found'
import { RequireAuth } from '@/features/auth/require-auth'
import { SessionProvider } from '@/features/auth/session-provider'
import { AcceptInvitationPage } from '@/features/tenancy/accept-invitation-page'
import { TenantProvider } from '@/features/tenancy/tenant-provider'

/**
 * The authenticated seller surface, in its own module so it becomes its own
 * chunk (see `App.tsx`).
 *
 * A buyer landing on `{slug}.selld.ph` must not download auth, tenancy, and the
 * whole dashboard shell to see a product page — the storefront carries a hard
 * LCP < 2.0s on 3G budget from phase 5, on mobile data.
 */
export default function DashboardApp() {
  // Every navigation destination exists as a route from phase 0; the ones whose
  // phase has not shipped render a placeholder instead of 404ing.
  const pending = ALL_NAV_ITEMS.filter((item) => item.to !== '/')

  return (
    <SessionProvider>
      <TenantProvider>
        <Routes>
          {/* Accepting an invitation must work before the invitee has any tenant,
              so it sits outside RequireAuth's tenant check. */}
          <Route path="/invite/:token" element={<AcceptInvitationPage />} />

          <Route
            element={
              <RequireAuth>
                <DashboardLayout />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardHome />} />
            {pending.map((item) => (
              <Route key={item.to} path={item.to} element={<ComingSoon />} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </TenantProvider>
    </SessionProvider>
  )
}
