import { useTranslation } from 'react-i18next'

import { useStorefront } from '../use-storefront'

export function StoreFooter() {
  const { t } = useTranslation()
  const { store } = useStorefront()

  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-8 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{store.name}</p>
        <p>{t('storefront.footerCod')}</p>
        {/* Attribution, not a paywall: Selld charges no commission, and a small
            credit on a seller's store is how other sellers find us. */}
        <p className="mt-2">
          {t('storefront.poweredBy')}{' '}
          <a href="https://selld.ph" className="underline underline-offset-2">
            Selld
          </a>
        </p>
      </div>
    </footer>
  )
}
