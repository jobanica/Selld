import { Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Storefront entry point.
 *
 * The real storefront arrives in phase 5, served at `{slug}.selld.ph` and on
 * custom domains. It lives in its own directory from phase 0 because it has
 * fundamentally different constraints from the dashboard: it is anonymous,
 * public, SEO-relevant, and has a hard LCP < 2.0s on 3G budget — so it must not
 * accumulate dashboard dependencies by accident.
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
        <p className="max-w-sm text-sm text-muted-foreground">{t('common.comingSoon')}</p>
      </div>
    </main>
  )
}
