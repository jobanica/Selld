import { useTranslation } from 'react-i18next'

import { formatPHP } from '@/lib/money'
import { cn } from '@/lib/utils'

import { price, priceRange, srcSet, type ProductCard as ProductCardData } from '../storefront-data'
import { CARD_IMAGE_SIZES, NATURAL_IMAGE_WIDTH, priorityAttrs } from '../image-config'
import { useStorageUrl, useStoreHref, useStorefront } from '../use-storefront'

/**
 * One product in the grid.
 *
 * `priority` marks the card that is most likely to be the LCP element — the
 * first one on the page. Its image is fetched eagerly at high priority; every
 * other image is lazy. Marking them all eager would make the browser compete
 * with itself for bandwidth on a 3G link and delay the very image that decides
 * the LCP score.
 */
export function ProductCard({
  product,
  priority = false,
}: {
  product: ProductCardData
  priority?: boolean
}) {
  const href = useStoreHref()
  const { t } = useTranslation()
  const toUrl = useStorageUrl()
  const { storageOrigin } = useStorefront()
  const image = toUrl(product.image)
  const set = srcSet(storageOrigin, product.image, product.renditions, NATURAL_IMAGE_WIDTH)
  const { from, to, isRange } = priceRange(product)
  const compareAt = price(product.compareAt)

  /**
   * The badge the reference marketplace puts on a discounted tile.
   *
   * Derived from the two prices already on the product — never stored, never
   * guessed. No compare-at price means no badge, rather than a badge reading
   * -0%, and a compare-at that is not actually higher is a seller mistake we
   * decline to advertise. Integer arithmetic on centavos: hard rule 2 applies
   * to a percentage as much as to a total.
   */
  const discountPercent =
    from === null || compareAt === null || compareAt <= from
      ? null
      : Math.round(((compareAt - from) * 100) / compareAt)

  // Built here rather than inline so `to` narrows properly. Reaching for a
  // non-null assertion or a cast would work around the branded Centavos type
  // instead of using it, which is the one thing money handling must not do.
  const priceLabel =
    from === null
      ? t('storefront.priceUnavailable')
      : isRange && to !== null
        ? `${formatPHP(from)} – ${formatPHP(to)}`
        : formatPHP(from)

  return (
    <a
      href={href(`/p/${product.slug}`)}
      className="group flex w-full flex-col rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {/*
        aspect-square on the wrapper reserves the space before the image loads,
        so a slow photo cannot shift the grid underneath a buyer's thumb. This is
        the whole CLS story for this page.
      */}
      <div className="relative aspect-square overflow-hidden rounded-xl bg-muted/60">
        {image === null ? (
          <span
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-3xl font-semibold text-muted-foreground/40"
          >
            {product.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img
            src={image}
            {...(set === null ? {} : { srcSet: set })}
            // Without this the browser assumes 100vw and picks a candidate about
            // twice as large as the slot it will be drawn into.
            sizes={CARD_IMAGE_SIZES}
            alt={product.imageAlt ?? product.name}
            width={600}
            height={600}
            loading={priority ? 'eager' : 'lazy'}
            {...priorityAttrs(priority)}
            decoding={priority ? 'sync' : 'async'}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        )}

        {discountPercent !== null && product.inStock && (
          <span className="absolute left-2 top-2 rounded-md bg-destructive px-1.5 py-0.5 text-[11px] font-bold text-destructive-foreground">
            {t('storefront.percentOff', { percent: discountPercent })}
          </span>
        )}

        {!product.inStock && (
          <span className="absolute inset-x-0 bottom-0 bg-foreground/75 py-1 text-center text-xs font-medium text-background">
            {t('storefront.soldOut')}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 pt-2.5">
        <h3 className="line-clamp-2 text-sm leading-snug text-foreground/90 group-hover:underline">
          {product.name}
        </h3>
        <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-0.5">
          <span
            className={cn(
              'text-base font-bold tracking-tight',
              !product.inStock && 'text-muted-foreground',
            )}
          >
            {priceLabel}
          </span>
          {compareAt !== null && (
            <span className="text-xs text-muted-foreground line-through">
              {formatPHP(compareAt)}
            </span>
          )}
        </div>
      </div>
    </a>
  )
}
