import { useTranslation } from 'react-i18next'

import { useStorefront } from '../use-storefront'
import { StoreHoursList, StorePaymentList } from './store-info'

export function StoreFooter() {
  const { t } = useTranslation()
  const { store } = useStorefront()

  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        {/* Hours and payment sit above the credit, and only where there is
            something true to say. The line that used to be here read "Cash on
            delivery available nationwide" for every store on the platform —
            including the ones that had switched COD off. */}
        {(store.hours !== null || store.payments.cod || store.payments.methods.length > 0) && (
          <div className="mx-auto mb-6 grid max-w-2xl gap-6 sm:grid-cols-2">
            {store.hours !== null && (
              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('storefront.hoursTitle')}
                </h2>
                <StoreHoursList hours={store.hours} />
                {store.hours.note !== '' && (
                  <p className="text-xs text-muted-foreground">{store.hours.note}</p>
                )}
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('storefront.paymentTitle')}
              </h2>
              <StorePaymentList payments={store.payments} />
            </section>
          </div>
        )}

        <div className="flex flex-col gap-1 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{store.name}</p>
          {/* Attribution, not a paywall: Selld charges no commission, and a small
              credit on a seller's store is how other sellers find us. */}
          <p className="mt-2">
            {t('storefront.poweredBy')}{' '}
            <a href="https://selld.ph" className="underline underline-offset-2">
              Selld
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}
