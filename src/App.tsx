import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useMemo, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'

import { env } from '@/lib/env'
import { resolveSurface } from '@/lib/tenant/resolve-tenant'

/**
 * Selld serves two apps from one deployment, chosen by hostname:
 *
 *   selld.ph / app.selld.ph   -> the dashboard
 *   {slug}.selld.ph, custom   -> a tenant storefront
 *
 * They are lazy-loaded so each becomes its own chunk. A buyer on a storefront
 * never downloads auth, tenancy, or the dashboard shell, which is what makes
 * phase 5's LCP < 2.0s on 3G budget reachable on mobile data.
 */
const DashboardApp = lazy(() => import('@/app/dashboard-app'))
const StorefrontApp = lazy(() => import('@/storefront/storefront-app'))

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

  const surface = useMemo(
    () => resolveSurface(window.location.hostname, { rootDomain: env.rootDomain }),
    [],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<SurfaceFallback />}>
          {surface.kind === 'dashboard' ? (
            <DashboardApp />
          ) : (
            <StorefrontApp surface={surface} />
          )}
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/**
 * Shown only while the surface chunk loads. Deliberately unstyled beyond a
 * spinner and carrying no translated copy — i18n resources may not have been
 * needed yet, and a flash of English at a Taglish seller is worse than a
 * wordless spinner.
 */
function SurfaceFallback() {
  return (
    <div className="grid min-h-dvh place-items-center" role="status" aria-busy="true">
      <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  )
}
