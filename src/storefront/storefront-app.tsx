import type { SurfaceTarget } from '@/lib/tenant/resolve-tenant'
import { StorefrontPlaceholder } from '@/storefront/storefront-placeholder'

/**
 * The public buyer surface, in its own chunk.
 *
 * Phase 5 fills this in. It must stay free of dashboard dependencies —
 * every import added here is bytes on a buyer's mobile connection, measured
 * against the LCP < 2.0s on 3G budget.
 */
export default function StorefrontApp({ surface }: { surface: SurfaceTarget }) {
  const slug = surface.kind === 'storefront' ? surface.slug : 'storefront'
  const hostname = surface.kind === 'custom-domain' ? surface.hostname : null

  return <StorefrontPlaceholder slug={hostname ?? slug} />
}
