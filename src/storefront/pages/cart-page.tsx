import { Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatPHP } from '@/lib/money'
import { cn } from '@/lib/utils'

import { money, type CartQuote } from '../cart-data'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import { CARD_IMAGE_SIZES, NATURAL_IMAGE_WIDTH } from '../image-config'
import { srcSet } from '../storefront-data'
import { useStorageUrl, useStoreHref, useStorefront } from '../use-storefront'

/**
 * The cart.
 *
 * Every control is a real form. The quantity stepper is two submit buttons, remove
 * is a submit button, and checkout is a link — so the whole page works with
 * JavaScript disabled, which is the state a buyer on a slow connection is in for
 * the first second or two.
 *
 * No total is computed here. Every number rendered came from `cart_pricing()`
 * server-side; adding client arithmetic would create a second source of truth for
 * money, and the one the buyer saw is the one they will argue about.
 */
export function CartPage({ quote }: { quote: CartQuote | null }) {
  const href = useStoreHref()
  const { t } = useTranslation()
  const { storageOrigin } = useStorefront()
  const toUrl = useStorageUrl()

  const items = quote?.items ?? []
  const isEmpty = items.length === 0

  return (
    <>
      <StoreHeader showSearch={false} />

      <main className="mx-auto w-full max-w-3xl px-4 pb-32 sm:pb-16">
        <h1 className="py-4 font-headline text-xl font-bold tracking-tight sm:text-2xl">
          {t('cart.title')}
        </h1>

        {isEmpty ? (
          <div className="rounded-xl border border-dashed py-16 text-center">
            <span
              aria-hidden="true"
              className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"
            >
              <ShoppingBag className="size-6" />
            </span>
            <p className="font-medium">{t('cart.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('cart.emptyHint')}</p>
            <a
              href={href('/')}
              className="mt-4 inline-flex h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
            >
              {t('cart.startShopping')}
            </a>
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-xl border">
              {items.map((line) => {
                const image = toUrl(line.image)
                const set = srcSet(storageOrigin, line.image, line.renditions, NATURAL_IMAGE_WIDTH)
                return (
                  <li key={line.variantId} className="flex gap-3 p-3">
                    <a
                      href={href(`/p/${line.productSlug}`)}
                      className="size-20 shrink-0 overflow-hidden rounded-lg bg-muted"
                    >
                      {image === null ? (
                        <span
                          aria-hidden="true"
                          className="flex h-full w-full items-center justify-center text-xl font-semibold text-muted-foreground/40"
                        >
                          {line.productName.slice(0, 1).toUpperCase()}
                        </span>
                      ) : (
                        <img
                          src={image}
                          {...(set === null ? {} : { srcSet: set })}
                          sizes={CARD_IMAGE_SIZES}
                          alt=""
                          width={160}
                          height={160}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </a>

                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <a href={href(`/p/${line.productSlug}`)} className="text-sm font-medium leading-snug">
                        {line.productName}
                      </a>
                      {line.variantLabel !== null && (
                        <span className="text-xs text-muted-foreground">{line.variantLabel}</span>
                      )}

                      <span className="text-sm font-semibold">
                        {formatPHP(money(line.unitPrice))}
                      </span>

                      {/* A price that moved since it was added is stated, not
                          hidden. The buyer is about to be charged the new one. */}
                      {line.priceChanged && (
                        <span className="text-xs text-warning">
                          {t('cart.priceChanged', {
                            was: formatPHP(money(line.snapshotPrice)),
                          })}
                        </span>
                      )}
                      {!line.inStock && (
                        <span className="text-xs font-medium text-destructive">
                          {t('cart.lineSoldOut')}
                        </span>
                      )}

                      <div className="mt-1 flex items-center gap-2">
                        <QtyStepper variantId={line.variantId} qty={line.qty} />
                        <form method="post" action={href('/cart/qty')} className="ml-auto">
                          <input type="hidden" name="variantId" value={line.variantId} />
                          <input type="hidden" name="qty" value="0" />
                          <button
                            type="submit"
                            aria-label={t('cart.remove')}
                            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-destructive"
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </button>
                        </form>
                      </div>
                    </div>

                    <span className="shrink-0 text-right text-sm font-semibold tabular">
                      {formatPHP(money(line.lineTotal))}
                    </span>
                  </li>
                )
              })}
            </ul>

            {quote !== null && <Totals quote={quote} />}
          </>
        )}
      </main>

      {/* Thumb-reachable checkout, same pattern as the product page. */}
      {!isEmpty && quote !== null && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{t('cart.grandTotal')}</p>
              <p className="font-semibold">{formatPHP(money(quote.grandTotal))}</p>
            </div>
            <a
              href={href('/checkout')}
              className="flex h-12 shrink-0 items-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground"
            >
              {t('cart.checkout')}
            </a>
          </div>
        </div>
      )}

      <StoreFooter />
    </>
  )
}

/**
 * Quantity stepper as two submit buttons.
 *
 * Not an `<input type="number">` with an onChange: that needs JavaScript to
 * submit, and typing into a number field on Android opens a keyboard the buyer then
 * has to dismiss. Two 44px targets is one tap per unit and works with no JS at all.
 */
function QtyStepper({ variantId, qty }: { variantId: string; qty: number }) {
  const href = useStoreHref()
  const { t } = useTranslation()
  return (
    <div className="flex items-center rounded-lg border">
      <form method="post" action={href('/cart/qty')}>
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="qty" value={Math.max(0, qty - 1)} />
        <button
          type="submit"
          aria-label={t('cart.decrease')}
          className="grid size-11 place-items-center rounded-l-lg hover:bg-accent"
        >
          <Minus className="size-4" aria-hidden="true" />
        </button>
      </form>
      <span aria-live="polite" className="min-w-8 text-center text-sm font-medium tabular">
        {qty}
      </span>
      <form method="post" action={href('/cart/qty')}>
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="qty" value={qty + 1} />
        <button
          type="submit"
          aria-label={t('cart.increase')}
          className="grid size-11 place-items-center rounded-r-lg hover:bg-accent"
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}

export function Totals({ quote, className }: { quote: CartQuote; className?: string }) {
  const { t } = useTranslation()

  // "Add ₱240 more for free shipping" converts better than any discount badge, and
  // it is only honest when a threshold actually exists and has not been reached.
  const freeOver = quote.shipping?.freeOver ?? null
  const freeOverGap =
    freeOver !== null && freeOver !== undefined && !(quote.shipping?.freeApplied ?? false)
      ? freeOver - quote.subtotal
      : null

  return (
    <dl className={cn('mt-4 flex flex-col gap-1.5 rounded-xl border p-4 text-sm', className)}>
      <Row label={t('cart.subtotal')} value={formatPHP(money(quote.subtotal))} />
      <Row
        label={
          // Said plainly. Before a destination is known this is the catch-all zone's
          // price, and a buyer who sees it change at checkout with no explanation
          // concludes the store is playing games.
          quote.shippingEstimated === true ? t('cart.shippingEstimated') : t('cart.shipping')
        }
        value={
          quote.shippingTotal === 0 ? t('cart.free') : formatPHP(money(quote.shippingTotal))
        }
      />
      {freeOverGap !== null && (
        <p className="text-xs text-primary">
          {t('cart.freeShippingNudge', { amount: formatPHP(money(freeOverGap)) })}
        </p>
      )}
      {quote.codFee > 0 && (
        <Row label={t('cart.codFee')} value={formatPHP(money(quote.codFee))} />
      )}
      {quote.discountTotal > 0 && (
        <Row
          label={t('cart.discount')}
          value={`−${formatPHP(money(quote.discountTotal))}`}
        />
      )}
      <div className="mt-1.5 flex items-baseline justify-between border-t pt-2.5">
        <dt className="font-semibold">{t('cart.grandTotal')}</dt>
        <dd className="text-lg font-bold tabular">{formatPHP(money(quote.grandTotal))}</dd>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('cart.totalsNote')}</p>
    </dl>
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
