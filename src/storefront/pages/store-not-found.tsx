import { Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * No store at this hostname, or no such product.
 *
 * Rendered unbranded on purpose when `store` is null: there is no tenant to take
 * branding from, and guessing would show one seller's colours on another's
 * mistyped URL.
 */
export function StoreNotFound({ hostname }: { hostname: string }) {
  const { t } = useTranslation()

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"
        >
          <Store className="size-6" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">{t('storefront.noStoreTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('storefront.noStoreBody', { hostname })}
        </p>
        <a
          href="https://selld.ph"
          className="mt-2 inline-flex h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
        >
          {t('storefront.noStoreCta')}
        </a>
      </div>
    </main>
  )
}
