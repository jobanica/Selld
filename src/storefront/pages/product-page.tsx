import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatPHP, isPositive, subtract } from '@/lib/money'
import { cn } from '@/lib/utils'

import { ProductCard } from '../components/product-card'
import { NATURAL_IMAGE_WIDTH, PRODUCT_IMAGE_SIZES, priorityAttrs } from '../image-config'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import {
  isOptionValueAvailable,
  matchVariant,
  price,
  renditionPath,
  srcSet,
  type ProductPayload,
} from '../storefront-data'
import { useStorageUrl, useStorefront } from '../use-storefront'

/**
 * Product detail.
 *
 * Everything above the fold is server-rendered, including the price of the
 * default variant, so the page is readable and shareable before any JavaScript
 * runs. Hydration adds the gallery and the variant picker.
 */
export function ProductPage({ payload }: { payload: ProductPayload }) {
  const { t } = useTranslation()
  const toUrl = useStorageUrl()
  const { storageOrigin } = useStorefront()
  const { product, images, options, variants, related } = payload

  // Hooks first, unconditionally. The `product === null` guard below used to sit
  // above these, which reads fine but is a rules-of-hooks violation: a component
  // that returns early on one render and calls two useStates on the next
  // desyncs React's hook order.
  const [selected, setSelected] = useState<Record<string, string>>(() => initialSelection(payload))
  const [activeImage, setActiveImage] = useState(0)

  // The renderer only mounts this page when `product` is non-null; the guard is
  // here so the component is safe to use directly in a test.
  if (product === null) return null

  const variant = matchVariant(variants, selected)
  const needsChoice = options.length > 0 && variant === null

  // With no variant chosen yet, show the cheapest price rather than nothing —
  // a product page with a blank price reads as broken.
  const shown = variant ?? cheapest(variants)
  const shownPrice = price(shown?.price ?? null)
  const shownCompareAt = price(shown?.compareAt ?? null)
  // Narrowed rather than asserted — `subtract` takes two Centavos and there is
  // no honest way to spell that with a `!`.
  const savings =
    shownCompareAt !== null && shownPrice !== null ? subtract(shownCompareAt, shownPrice) : null

  const gallery = images.filter((image) => image.variantId === null || image.variantId === shown?.id)
  const current = gallery[Math.min(activeImage, Math.max(0, gallery.length - 1))] ?? null
  const currentUrl = toUrl(current?.path ?? null)
  const currentSrcSet = srcSet(
    storageOrigin,
    current?.path ?? null,
    current?.renditions ?? [],
    NATURAL_IMAGE_WIDTH,
  )

  const soldOut = variants.length > 0 && variants.every((candidate) => !candidate.inStock)

  return (
    <>
      <StoreHeader showSearch={false} />

      <main className="mx-auto w-full max-w-6xl px-4 pb-28 sm:pb-16">
        <nav className="py-3 text-sm">
          <a
            href={product.categorySlug === null ? '/' : `/?category=${product.categorySlug}`}
            className="inline-flex h-11 items-center gap-1 -ml-1 pr-2 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {product.categoryName ?? t('storefront.allProducts')}
          </a>
        </nav>

        <div className="grid gap-6 sm:grid-cols-2 sm:gap-8">
          {/* Gallery */}
          <div>
            <div className="aspect-square overflow-hidden rounded-xl border bg-muted">
              {currentUrl === null ? (
                <span
                  aria-hidden="true"
                  className="flex h-full w-full items-center justify-center text-6xl font-semibold text-muted-foreground/30"
                >
                  {product.name.slice(0, 1).toUpperCase()}
                </span>
              ) : (
                <img
                  src={currentUrl}
                  {...(currentSrcSet === null ? {} : { srcSet: currentSrcSet })}
                  sizes={PRODUCT_IMAGE_SIZES}
                  alt={current?.alt ?? product.name}
                  width={900}
                  height={900}
                  // The LCP element on this page. Eager, high priority, and
                  // decoded synchronously so it paints in the first frame it can.
                  {...priorityAttrs(true)}
                  decoding="sync"
                  className="h-full w-full object-cover"
                />
              )}
            </div>

            {gallery.length > 1 && (
              <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {gallery.map((image, index) => (
                  <li key={image.id}>
                    <button
                      type="button"
                      onClick={() => setActiveImage(index)}
                      aria-label={t('storefront.viewImage', { n: index + 1 })}
                      aria-current={index === activeImage}
                      className={cn(
                        'size-16 shrink-0 overflow-hidden rounded-lg border-2',
                        index === activeImage ? 'border-primary' : 'border-transparent',
                      )}
                    >
                      <img
                        // A 64px thumbnail has no business downloading the
                        // full-size original, so prefer the smallest rendition.
                        src={toUrl(smallestRendition(image)) ?? ''}
                        alt=""
                        width={64}
                        height={64}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Detail */}
          <div className="flex flex-col gap-4">
            <div>
              <h1 className="font-headline text-xl font-bold leading-tight tracking-tight text-balance sm:text-3xl">
                {product.name}
              </h1>
              <div className="mt-2 flex flex-wrap items-baseline gap-2">
                <span className="text-2xl font-bold">
                  {shownPrice === null ? t('storefront.priceUnavailable') : formatPHP(shownPrice)}
                </span>
                {shownCompareAt !== null && (
                  <>
                    <span className="text-sm text-muted-foreground line-through">
                      {formatPHP(shownCompareAt)}
                    </span>
                    {savings !== null && isPositive(savings) && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                        {t('storefront.saveAmount', {
                          amount: formatPHP(savings, { cents: false }),
                        })}
                      </span>
                    )}
                  </>
                )}
              </div>
              <StockLine soldOut={soldOut} state={shown?.stockState ?? 'out'} />
            </div>

            {options.map((option) => (
              <fieldset key={option.id}>
                <legend className="mb-1.5 text-sm font-medium">{option.name}</legend>
                <div className="flex flex-wrap gap-2">
                  {option.values.map((value) => {
                    const available = isOptionValueAvailable(
                      variants,
                      value.id,
                      selected,
                      option.id,
                    )
                    const isSelected = selected[option.id] === value.id
                    return (
                      <button
                        key={value.id}
                        type="button"
                        disabled={!available}
                        aria-pressed={isSelected}
                        onClick={() =>
                          setSelected((previous) => ({ ...previous, [option.id]: value.id }))
                        }
                        className={cn(
                          'h-11 min-w-11 rounded-lg border px-3.5 text-sm transition-colors',
                          isSelected && 'border-primary bg-primary text-primary-foreground',
                          // Sold-out values stay visible and struck through, not
                          // hidden — hiding them makes the product look like it
                          // was never offered in that size.
                          !available &&
                            'cursor-not-allowed text-muted-foreground/60 line-through opacity-60',
                        )}
                      >
                        {value.value}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            ))}

            {product.description !== null && product.description.trim() !== '' && (
              <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
                {product.description}
              </div>
            )}

            <dl className="grid gap-1 text-xs text-muted-foreground">
              {product.isCodAllowed && (
                <div className="flex gap-1.5">
                  <dt className="font-medium text-foreground">{t('storefront.codLabel')}</dt>
                  <dd>{t('storefront.codAvailable')}</dd>
                </div>
              )}
              {shown?.sku !== null && shown?.sku !== undefined && (
                <div className="flex gap-1.5">
                  <dt className="font-medium text-foreground">{t('storefront.skuLabel')}</dt>
                  <dd>{shown.sku}</dd>
                </div>
              )}
            </dl>

            {/*
              Desktop add-to-cart. On phones the sticky bar below takes over, so
              this is hidden there rather than duplicated in the flow.
            */}
            <div className="hidden sm:block">
              <AddToCart
                disabled={soldOut || needsChoice || variant?.inStock === false}
                label={
                  soldOut
                    ? t('storefront.soldOut')
                    : needsChoice
                      ? t('storefront.chooseOption', { option: firstUnchosen(options, selected) })
                      : variant?.inStock === false
                        ? t('storefront.variantSoldOut')
                        : t('storefront.addToCart')
                }
              />
            </div>
          </div>
        </div>

        {related.length > 0 && (
          // `content-visibility: auto` was tried here to keep the related row's
          // four lazy images out of the initial load. It did not help and made
          // the result non-deterministic — LCP alternated between 2.1s and 3.5s
          // across runs, because whether the subtree counts as relevant depends
          // on viewport state at measurement time. A stable 2.1s beats a number
          // that is sometimes better and sometimes much worse.
          <section className="mt-12">
            <h2 className="mb-3 font-headline text-lg font-semibold">
              {t('storefront.alsoFromStore')}
            </h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {related.map((card) => (
                <li key={card.id} className="flex">
                  <ProductCard product={card} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {/*
        Thumb-reachable add-to-cart, per the phase brief. Fixed to the bottom of
        the viewport on phones so it is reachable one-handed no matter how long
        the description is, and padded for the iOS home indicator.
      */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">{product.name}</p>
            <p className="font-semibold">
              {shownPrice === null ? t('storefront.priceUnavailable') : formatPHP(shownPrice)}
            </p>
          </div>
          <AddToCart
            className="w-auto shrink-0 px-6"
            disabled={soldOut || needsChoice || variant?.inStock === false}
            label={
              soldOut
                ? t('storefront.soldOut')
                : needsChoice
                  ? t('storefront.chooseOptionShort')
                  : variant?.inStock === false
                    ? t('storefront.variantSoldOut')
                    : t('storefront.addToCart')
            }
          />
        </div>
      </div>

      <StoreFooter />
    </>
  )
}

/**
 * Add to cart.
 *
 * Phase 6 owns the cart. Until then this is a real, correctly-stated control
 * rather than a fake one: it reflects stock and option state, and says plainly
 * that checkout is not open yet instead of pretending to add something.
 */
function AddToCart({
  label,
  disabled,
  className,
}: {
  label: string
  disabled: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [notice, setNotice] = useState(false)

  return (
    <div className={cn('w-full', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setNotice(true)}
        className={cn(
          'h-12 w-full rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        {label}
      </button>
      {notice && (
        <p role="status" className="mt-1.5 text-center text-xs text-muted-foreground">
          {t('storefront.checkoutComingSoon')}
        </p>
      )}
    </div>
  )
}

function StockLine({ soldOut, state }: { soldOut: boolean; state: 'ok' | 'low' | 'out' }) {
  const { t } = useTranslation()
  if (soldOut) {
    return <p className="mt-1 text-sm font-medium text-destructive">{t('storefront.soldOut')}</p>
  }
  if (state === 'low') {
    // A coarse "few left" only — the exact count is deliberately not exposed by
    // storefront_availability, and inventing precision here would leak it.
    return <p className="mt-1 text-sm font-medium text-warning">{t('storefront.lowStock')}</p>
  }
  if (state === 'out') {
    return (
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        {t('storefront.variantSoldOut')}
      </p>
    )
  }
  return <p className="mt-1 text-sm text-success">{t('storefront.inStock')}</p>
}

/**
 * Preselect when there is nothing to choose.
 *
 * A single-variant product needs no picker, and a buyer should not have to tap
 * "Small" when Small is the only size. Multi-option products start unselected so
 * the price shown is a real one rather than an arbitrary combination's.
 */
function initialSelection(payload: ProductPayload): Record<string, string> {
  const { options, variants } = payload
  if (options.length !== 1 || variants.length === 0) return {}

  const option = options[0]!
  const inStock = variants.filter((variant) => variant.inStock)
  if (inStock.length !== 1) return {}

  const only = inStock[0]!
  const value = option.values.find((candidate) => only.optionValueIds.includes(candidate.id))
  return value === undefined ? {} : { [option.id]: value.id }
}

/** Smallest available rendition, falling back to the original. */
function smallestRendition(image: ProductPayload['images'][number]): string {
  const smallest = [...image.renditions].sort((a, b) => a - b)[0]
  return smallest === undefined ? image.path : renditionPath(image.path, smallest)
}

function cheapest(variants: ProductPayload['variants']) {
  return variants.reduce<ProductPayload['variants'][number] | null>(
    (best, candidate) => (best === null || candidate.price < best.price ? candidate : best),
    null,
  )
}

function firstUnchosen(
  options: ProductPayload['options'],
  selected: Record<string, string>,
): string {
  return options.find((option) => (selected[option.id] ?? '') === '')?.name ?? ''
}
