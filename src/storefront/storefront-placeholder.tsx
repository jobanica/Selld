import { Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Signpost shown when a storefront hostname is opened against the dashboard SPA.
 *
 * The real storefront is server-rendered — see `storefront-app.tsx`. Reaching this
 * screen in dev means you want `pnpm dev:store` on port 5174, not `pnpm dev`.
 */
export function StorefrontPlaceholder({ slug }: { slug: string }) {
  const { t } = useTranslation()

  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Store className="size-6" aria-hidden="true" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">{slug}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t('storefront.wrongServer')}
        </p>
      </div>
    </main>
  )
}
