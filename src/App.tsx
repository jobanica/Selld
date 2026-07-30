import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { DashboardLayout } from '@/app/dashboard-layout'
import { ComingSoon } from '@/app/pages/coming-soon'
import { DashboardHome } from '@/app/pages/dashboard-home'
import { NotFound } from '@/app/pages/not-found'
import { ALL_NAV_ITEMS } from '@/app/navigation'
import { env } from '@/lib/env'
import { resolveSurface } from '@/lib/tenant/resolve-tenant'
import { StorefrontPlaceholder } from '@/storefront/storefront-placeholder'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Sellers are on mobile data. Refetching on every window focus burns
        // their load allowance for no benefit; explicit invalidation is enough.
        refetchOnWindowFocus: false,
        retry: 2,
        staleTime: 30_000,
      },
    },
  })
}

export function App() {
  // useState rather than useMemo: React only *guarantees* stability for state,
  // and a re-created QueryClient would silently drop every cache entry.
  const [queryClient] = useState(createQueryClient)

  // Which app to serve is decided by hostname, not by route.
  const surface = useMemo(
    () => resolveSurface(window.location.hostname, { rootDomain: env.rootDomain }),
    [],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {surface.kind === 'dashboard' ? (
          <DashboardRoutes />
        ) : (
          <StorefrontPlaceholder
            slug={surface.kind === 'storefront' ? surface.slug : surface.hostname}
          />
        )}
      </BrowserRouter>
    </QueryClientProvider>
  )
}

function DashboardRoutes() {
  // Every navigation destination exists as a route from phase 0; the ones whose
  // phase has not shipped render a placeholder instead of 404ing.
  const pending = ALL_NAV_ITEMS.filter((item) => item.to !== '/')

  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<DashboardHome />} />
        {pending.map((item) => (
          <Route key={item.to} path={item.to} element={<ComingSoon />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
