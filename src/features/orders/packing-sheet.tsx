import { useQuery } from '@tanstack/react-query'
import { Printer, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'

import { fetchPackingBatch } from './orders-api'

/**
 * Packing slips and the picking list, for a batch.
 *
 * **Printed by the browser, not generated as a PDF server-side.** The spec says
 * "PDF (batch print)", and every browser's print dialog produces exactly that via
 * "Save as PDF" — including on Android and iOS, which is where a seller actually is.
 * A server-side pipeline would mean a headless-Chrome dependency, a render queue and
 * a download step, to arrive at the same file the print dialog already makes. It
 * would also break the one case that matters most: a seller with a thermal printer
 * paired to their phone.
 *
 * **The picking list comes first, on its own page.** It is the thing that saves the
 * time: one row per SKU across the whole batch, so the shelves get walked once
 * rather than once per order. Sellers who pack order-by-order are the ones for whom
 * fifty orders takes an afternoon.
 */
export function PackingSheet({
  orderIds,
  onClose,
}: {
  orderIds: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const batch = useQuery({
    queryKey: ['packing-batch', tenant.id, orderIds],
    queryFn: () => fetchPackingBatch({ tenantId: tenant.id, orderIds }),
  })

  const data = batch.data

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* `print:hidden` on the chrome: what prints is the slips, not the app. */}
      <header className="flex items-center gap-2 border-b p-3 print:hidden">
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-5" aria-hidden="true" />
        </Button>
        <h2 className="flex-1 text-lg font-semibold">
          {t('orders.packingFor', { count: orderIds.length })}
        </h2>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          {t('orders.print')}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 print:overflow-visible print:p-0">
        {data === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data === null ? (
          <p className="text-sm text-muted-foreground">{t('orders.notFound')}</p>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 print:max-w-none">
            {/* ---- Picking list ---- */}
            <section className="rounded-lg border p-4 print:break-after-page print:rounded-none print:border-0">
              <h3 className="text-lg font-semibold">{t('orders.pickingList')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('orders.pickingListHint', { count: data.orders.length })}
              </p>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1 font-medium">{t('orders.item')}</th>
                    <th className="py-1 font-medium">{t('orders.sku')}</th>
                    <th className="py-1 text-right font-medium">{t('orders.qty')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pickingList.map((line) => (
                    <tr key={`${line.sku ?? ''}${line.productName}${line.variantLabel ?? ''}`} className="border-b">
                      <td className="py-1">
                        {line.productName}
                        {line.variantLabel === null ? '' : ` · ${line.variantLabel}`}
                      </td>
                      <td className="py-1 tabular text-muted-foreground">{line.sku ?? '—'}</td>
                      <td className="py-1 text-right font-medium tabular">{line.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* ---- One slip per order ---- */}
            {data.orders.map((order) => (
              <section
                key={order.id}
                className="rounded-lg border p-4 print:break-after-page print:rounded-none print:border-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-semibold tabular">{order.orderNumber}</h3>
                  <span className="text-sm text-muted-foreground">{data.store.name}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatManilaDateTime(new Date(order.placedAt))}
                </p>

                <div className="mt-3 text-sm">
                  <p className="font-medium">{order.contactName}</p>
                  <p>{order.contactPhone}</p>
                  <p className="text-muted-foreground">
                    {[
                      order.address['street'],
                      order.address['barangayName'],
                      order.address['cityName'],
                      order.address['provinceName'],
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  {typeof order.address['landmark'] === 'string' &&
                    order.address['landmark'] !== '' && (
                      <p className="text-muted-foreground">{order.address['landmark']}</p>
                    )}
                </div>

                <table className="mt-3 w-full text-sm">
                  <tbody>
                    {order.items.map((item, index) => (
                      <tr key={`${item.sku ?? ''}${index}`} className="border-b">
                        <td className="py-1">
                          {item.productName}
                          {item.variantLabel === null ? '' : ` · ${item.variantLabel}`}
                        </td>
                        <td className="py-1 tabular text-muted-foreground">{item.sku ?? '—'}</td>
                        <td className="py-1 text-right font-medium tabular">× {item.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/*
                  The amount to collect, in its own box and large.
                  A rider handed a slip needs one number, and getting it wrong is the
                  seller's loss — so it says what is *due*, not the order total, which
                  are different the moment a buyer has partly paid.
                */}
                {order.codDue > 0 && (
                  <p className="mt-3 rounded-md border-2 border-foreground p-2 text-center text-lg font-bold">
                    {t('orders.collectOnDelivery', { amount: formatPHP(order.codDue) })}
                  </p>
                )}
                {order.codDue === 0 && (
                  <p className="mt-3 rounded-md border p-2 text-center text-sm font-medium">
                    {t('orders.alreadyPaid')}
                  </p>
                )}

                {order.buyerNote !== null && order.buyerNote !== '' && (
                  <p className="mt-2 text-sm">
                    <span className="text-muted-foreground">{t('orders.buyerNote')}: </span>
                    {order.buyerNote}
                  </p>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
