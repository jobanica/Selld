import type { SurfaceTarget } from '@/lib/tenant/resolve-tenant'
import { StorefrontPlaceholder } from '@/storefront/storefront-placeholder'

/**
 * Storefront hostname reached through the *dashboard SPA*.
 *
 * This is not the storefront. Since phase 5 the real storefront is server-rendered
 * by `server/storefront-server.ts` (`pnpm dev:store`, port 5174), because a
 * client-rendered page cannot meet its LCP budget. In production the SSR server
 * routes by hostname and the SPA never sees a storefront host at all.
 *
 * This path is only reachable in dev, by opening a storefront hostname against the
 * Vite SPA on :5173. It exists to say so, rather than to render a store.
 */
export default function StorefrontApp({ surface }: { surface: SurfaceTarget }) {
  const slug = surface.kind === 'storefront' ? surface.slug : 'storefront'
  const hostname = surface.kind === 'custom-domain' ? surface.hostname : null

  return <StorefrontPlaceholder slug={hostname ?? slug} />
}
