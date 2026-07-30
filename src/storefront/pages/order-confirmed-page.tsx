import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatPHP } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'

import { money, type OrderReceipt } from '../cart-data'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'

/**
 * Order confirmation.
 *
 * The order number leads, at a size a buyer can read out over the phone, because
 * that is the first thing a PH social-commerce buyer does after ordering — message
 * the seller. Everything a courier or the seller might ask about is on this one
 * screen so the buyer never has to go looking for it.
 */
export function OrderConfirmedPage({ receipt }: { receipt: OrderReceipt }) {
  const { t } = useTranslation()
  const address = receipt.address

  const addressLine = [
    address.street,
    address.barangayName,
    address.cityName,
    address.provinceName,
    address.regionName,
  ]
    .filter((part) => part !== null && part !== undefined && part !== '')
    .join(', ')

  return (
    <>
      <StoreHeader showSearch={false} />

      <main className="mx-auto w-full max-w-2xl px-4 pb-16">
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span
            aria-hidden="true"
            className="grid size-14 place-items-center rounded-full bg-success/15 text-success"
          >
            <Check className="size-7" />
          </span>
          <h1 className="font-headline text-xl font-bold tracking-tight sm:text-2xl">
            {t('confirmed.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('confirmed.body', { store: receipt.store.name })}
          </p>

          <p className="mt-1 rounded-lg bg-muted px-4 py-2">
            <span className="block text-xs uppercase tracking-wide text-muted-foreground">
              {t('confirmed.orderNumber')}
            </span>
            {/* Selectable and large: the buyer will read this to the seller. */}
            <span className="select-all text-2xl font-bold tracking-tight tabular">
              {receipt.orderNumber}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {formatManilaDateTime(receipt.placedAt)}
          </p>
        </div>

        <section className="flex flex-col gap-4">
          <div className="rounded-xl border">
            <h2 className="border-b px-4 py-2.5 text-sm font-semibold">{t('confirmed.items')}</h2>
            <ul className="flex flex-col divide-y text-sm">
              {receipt.items.map((item, index) => (
                <li key={`${item.sku ?? item.productName}-${index}`} className="flex gap-2 p-3">
                  <span className="min-w-0 flex-1">
                    {item.productName}
                    {item.variantLabel === null ? '' : ` · ${item.variantLabel}`}
                    <span className="text-muted-foreground"> × {item.qty}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular">
                    {formatPHP(money(item.lineTotal))}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="flex flex-col gap-1.5 border-t p-4 text-sm">
              <Row label={t('cart.subtotal')} value={formatPHP(money(receipt.subtotal))} />
              <Row
                label={t('cart.shipping')}
                value={
                  receipt.shippingTotal === 0
                    ? t('cart.free')
                    : formatPHP(money(receipt.shippingTotal))
                }
              />
              {receipt.codFee > 0 && (
                <Row label={t('cart.codFee')} value={formatPHP(money(receipt.codFee))} />
              )}
              <div className="mt-1.5 flex items-baseline justify-between border-t pt-2.5">
                <dt className="font-semibold">{t('confirmed.payOnDelivery')}</dt>
                <dd className="text-lg font-bold tabular">
                  {formatPHP(money(receipt.grandTotal))}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border p-4 text-sm">
            <h2 className="mb-2 text-sm font-semibold">{t('confirmed.deliverTo')}</h2>
            <p className="font-medium">{receipt.contactName}</p>
            <p className="text-muted-foreground">{receipt.contactPhone}</p>
            <p className="mt-1 text-muted-foreground">{addressLine}</p>
            {address.landmark !== undefined && address.landmark !== '' && (
              <p className="text-muted-foreground">
                {t('confirmed.landmark')}: {address.landmark}
              </p>
            )}
          </div>

          <p className="text-center text-sm text-muted-foreground">{t('confirmed.smsNote')}</p>

          <a
            href="/"
            className="mx-auto inline-flex h-11 items-center rounded-full border px-5 text-sm font-medium"
          >
            {t('confirmed.keepShopping')}
          </a>
        </section>
      </main>

      <StoreFooter />
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  )
}
