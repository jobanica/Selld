import { Route, Routes } from 'react-router-dom'

import { DashboardLayout } from '@/app/dashboard-layout'
import { ALL_NAV_ITEMS } from '@/app/navigation'
import { ComingSoon } from '@/app/pages/coming-soon'
import { DashboardHome } from '@/app/pages/dashboard-home'
import { NotFound } from '@/app/pages/not-found'
import { RequireAuth } from '@/features/auth/require-auth'
import { SessionProvider } from '@/features/auth/session-provider'
import { ProductListPage } from '@/features/catalog/product-list-page'
import { BroadcastsPage } from '@/features/broadcasts/broadcasts-page'
import { CodPage } from '@/features/cod/cod-page'
import { CustomersPage } from '@/features/customers/customers-page'
import { InboxPage } from '@/features/inbox/inbox-page'
import { InventoryPage } from '@/features/inventory/inventory-page'
import { LivePage } from '@/features/live/live-page'
import { OrdersPage } from '@/features/orders/orders-page'
import { PaymentsPage } from '@/features/payments/payments-page'
import { ShippingPage } from '@/features/shipping/shipping-page'
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
  // Routes that have a real implementation. Everything else in the nav still
  // renders a placeholder rather than 404ing.
  const implemented = new Set([
    '/', '/orders', '/products', '/inventory', '/shipping', '/payments', '/cod', '/live',
    '/inbox', '/customers', '/broadcasts',
  ])
  const pending = ALL_NAV_ITEMS.filter((item) => !implemented.has(item.to))

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
            <Route path="/products" element={<ProductListPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/shipping" element={<ShippingPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/cod" element={<CodPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/broadcasts" element={<BroadcastsPage />} />
            {/* Where the Facebook OAuth callback sends the seller back to. */}
            <Route path="/settings/social" element={<InboxPage />} />
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
