import { Route, Routes } from 'react-router-dom'

import { DashboardLayout } from '@/app/dashboard-layout'
import { ALL_NAV_ITEMS } from '@/app/navigation'
import { ConsoleLayout } from '@/app/console-layout'
import { ComingSoon } from '@/app/pages/coming-soon'
import { DashboardHome } from '@/app/pages/dashboard-home'
import { NotFound } from '@/app/pages/not-found'
import { RequireAuth } from '@/features/auth/require-auth'
import { SessionProvider } from '@/features/auth/session-provider'
import { ProductListPage } from '@/features/catalog/product-list-page'
import { BroadcastsPage } from '@/features/broadcasts/broadcasts-page'
import { AnalyticsPage } from '@/features/analytics/analytics-page'
import { BillingPage } from '@/features/billing/billing-page'
import { PlatformPage } from '@/features/platform/platform-page'
import { PrivacyPage } from '@/features/privacy/privacy-page'
import { ResellerPage } from '@/features/platform/reseller-page'
import { MarketplacesPage } from '@/features/marketplaces/marketplaces-page'
import { CodPage } from '@/features/cod/cod-page'
import { CustomersPage } from '@/features/customers/customers-page'
import { InboxPage } from '@/features/inbox/inbox-page'
import { InventoryPage } from '@/features/inventory/inventory-page'
import { LivePage } from '@/features/live/live-page'
import { HelpPage } from '@/features/onboarding/help-page'
import { OrdersPage } from '@/features/orders/orders-page'
import { PackingPage } from '@/features/orders/packing-page'
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
    '/inbox', '/customers', '/broadcasts', '/marketplaces', '/analytics', '/billing', '/privacy', '/packing', '/help',
  ])
  const pending = ALL_NAV_ITEMS.filter((item) => !implemented.has(item.to))

  return (
    <SessionProvider>
      <TenantProvider>
        <Routes>
          {/* Accepting an invitation must work before the invitee has any tenant,
              so it sits outside RequireAuth's tenant check. */}
          <Route path="/invite/:token" element={<AcceptInvitationPage />} />

          {/* Selld's console and a partner's console. Outside the tenant gate,
              because neither of their users owns a store — and not in the nav,
              because both check `is_platform_admin()` / `reseller_require()`
              server-side. A hidden link is a courtesy to the 99.9% of sellers
              these do not apply to; it is never the thing keeping anybody out. */}
          <Route
            element={
              <RequireAuth requireTenant={false}>
                <ConsoleLayout />
              </RequireAuth>
            }
          >
            <Route path="/admin" element={<PlatformPage />} />
            <Route path="/partner" element={<ResellerPage />} />
          </Route>

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
            <Route path="/packing" element={<PackingPage />} />
            <Route path="/cod" element={<CodPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/broadcasts" element={<BroadcastsPage />} />
            <Route path="/marketplaces" element={<MarketplacesPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/help" element={<HelpPage />} />
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
