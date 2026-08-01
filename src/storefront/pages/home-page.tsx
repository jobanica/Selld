import { useTranslation } from 'react-i18next'

import { ProductCard } from '../components/product-card'
import { priorityAttrs } from '../image-config'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import type { HomePayload } from '../storefront-data'
import { useStorageUrl, useStoreHref, useStorefront } from '../use-storefront'

/**
 * Store home: hero, then the grid.
 *
 * The hero is text-first. A store's hero image is optional and usually absent
 * for a new seller, and an LCP that depends on an image the seller never
 * uploaded is an LCP that fails for exactly the sellers we are trying to win.
 */
export function HomePage({
  payload,
  query,
}: {
  payload: HomePayload
  query: { category: string | null; search: string | null }
}) {
  const href = useStoreHref()
  const { t } = useTranslation()
  const { store } = useStorefront()
  const toUrl = useStorageUrl()

  const hero = store.theme.hero ?? {}
  const heroImage = toUrl(hero.imagePath ?? null)
  const search = query.search ?? ''
  const isFiltered = query.category !== null || search.trim() !== ''

  /**
   * Category tiles, illustrated with a product that is actually in them.
   *
   * The reference marketplace gives each category its own artwork. Selld has no
   * such column, and rather than add one — or ship grey circles — each tile
   * borrows the first in-stock product image from its own category. It is real
   * data, it is already in this payload, and it costs no extra round trip,
   * which is the rule this surface is built on.
   */
  const categoryTiles = payload.categories.map((category) => {
    const inCategory = payload.products.find(
      (product) => product.categorySlug === category.slug && product.image !== null,
    )
    return { ...category, image: toUrl(inCategory?.image ?? null) }
  })

  // The sale tile only appears when something is genuinely discounted, and it
  // quotes the deepest real discount in the store rather than a round number.
  const discounts = payload.products
    .map((product) =>
      product.compareAt === null || product.priceFrom === null
        ? 0
        : product.compareAt <= product.priceFrom
          ? 0
          : Math.round(((product.compareAt - product.priceFrom) * 100) / product.compareAt),
    )
    .filter((percent) => percent > 0)
  const onSaleCount = discounts.length
  const bestDiscount = onSaleCount === 0 ? 0 : Math.max(...discounts)

  return (
    <>
      <StoreHeader
        categories={payload.categories}
        activeCategory={query.category}
        search={search}
      />

      <main className="mx-auto w-full max-w-6xl px-4 pb-16">
        {/* The hero is suppressed while filtering — a buyer who just searched
            wants results, not the store's pitch pushed above them. */}
        {!isFiltered && (
          <>
            {/*
              The reference marketplace leads with a wide banner and a narrower
              one beside it. Same layout here, and deliberately *not* the
              auto-rotating carousel it sits in: a carousel needs JavaScript to
              be anything but its first slide, and this surface defers hydration
              until after load. A rotating banner would be a still image with a
              row of dots that do nothing for the first second of every visit,
              on the slowest connections, which is when it matters most.
            */}
            <section className="my-4 grid gap-3 sm:grid-cols-3">
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/15 via-background to-accent-brand/15 px-5 py-9 sm:col-span-2 sm:px-8 sm:py-14">
                {heroImage !== null && (
                  <img
                    src={heroImage}
                    alt=""
                    width={1200}
                    height={600}
                    {...priorityAttrs(true)}
                    decoding="sync"
                    className="absolute inset-0 h-full w-full object-cover opacity-25"
                  />
                )}
                <div className="relative max-w-xl">
                  <h1 className="font-headline text-2xl font-bold leading-tight tracking-tight text-balance sm:text-4xl">
                    {hero.headline ?? t('storefront.heroFallbackHeadline', { store: store.name })}
                  </h1>
                  <p className="mt-2.5 text-sm text-muted-foreground text-pretty sm:text-base">
                    {hero.subheadline ?? t('storefront.heroFallbackSubheadline')}
                  </p>
                  <span className="mt-5 inline-flex h-11 items-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground">
                    {t('storefront.shopNow')}
                  </span>
                </div>
              </div>

              {/* The companion tile. Only where there is something true to put
                  in it — an invented "50% OFF" starburst is the one thing a
                  seller's shop must never show. */}
              {onSaleCount > 0 && (
                <a
                  href={href('/')}
                  className="relative flex flex-col justify-center gap-4 overflow-hidden rounded-2xl bg-destructive px-5 py-7 text-destructive-foreground"
                >
                  <div>
                    <p className="text-xs font-semibold tracking-widest uppercase opacity-80">
                      {t('storefront.onSale')}
                    </p>
                    <p className="mt-1 font-headline text-3xl font-bold leading-none">
                      {t('storefront.percentOff', { percent: bestDiscount })}
                    </p>
                  </div>
                  <span className="inline-flex h-11 w-fit items-center rounded-full bg-background/95 px-5 text-sm font-semibold text-foreground">
                    {t('storefront.shopNow')}
                  </span>
                </a>
              )}
            </section>

            {categoryTiles.length > 1 && (
              <section className="mt-8" aria-labelledby="shop-by-category">
                <SectionHeading id="shop-by-category" title={t('storefront.shopByCategory')} />
                {/* Scrolls inside its own column rather than bleeding to the
                    screen edge — a negative margin here overhangs the page
                    padding and puts a horizontal scrollbar on the document. */}
                <ul className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {categoryTiles.map((tile) => (
                    <li key={tile.slug} className="shrink-0">
                      <a
                        href={href(`/?category=${tile.slug}`)}
                        className="flex w-[84px] flex-col items-center gap-2 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:w-24"
                      >
                        <span className="grid size-[76px] place-items-center overflow-hidden rounded-full bg-muted/60 sm:size-24">
                          {tile.image === null ? (
                            <span
                              aria-hidden="true"
                              className="text-2xl font-semibold text-muted-foreground/50"
                            >
                              {tile.name.slice(0, 1).toUpperCase()}
                            </span>
                          ) : (
                            <img
                              src={tile.image}
                              alt=""
                              width={96}
                              height={96}
                              loading="lazy"
                              decoding="async"
                              className="h-full w-full object-cover"
                            />
                          )}
                        </span>
                        <span className="line-clamp-2 text-center text-xs leading-tight">
                          {tile.name}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {isFiltered && (
          <div className="my-4 flex flex-wrap items-baseline gap-2">
            <h1 className="text-lg font-semibold">
              {search.trim() !== ''
                ? t('storefront.resultsFor', { query: search.trim() })
                : (payload.categories.find((c) => c.slug === query.category)?.name ??
                  t('storefront.allProducts'))}
            </h1>
            <span className="text-sm text-muted-foreground">
              {t('storefront.productCount', { count: payload.products.length })}
            </span>
          </div>
        )}

        {payload.products.length === 0 ? (
          <div className="rounded-xl border border-dashed py-16 text-center">
            <p className="font-medium">
              {isFiltered ? t('storefront.noResults') : t('storefront.storeEmpty')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isFiltered ? t('storefront.noResultsHint') : t('storefront.storeEmptyHint')}
            </p>
            {isFiltered && (
              <a
                href={href('/')}
                className="mt-4 inline-flex h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
              >
                {t('storefront.backToStore')}
              </a>
            )}
          </div>
        ) : (
          <>
            {!isFiltered && (
              <div className="mt-8">
                <SectionHeading id="all-products" title={t('storefront.freshPicks')} />
              </div>
            )}
            <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
              {payload.products.map((product, index) => (
                <li key={product.id} className="flex">
                {/* Only the first card is eager: it is the LCP candidate, and
                    making the rest compete with it for 3G bandwidth is how an
                    image-heavy grid loses the budget. */}
                  <ProductCard product={product} priority={index === 0} />
                </li>
              ))}
            </ul>
          </>
        )}
      </main>

      <StoreFooter />
    </>
  )
}

function SectionHeading({
  id,
  title,
  viewAllHref,
}: {
  id: string
  title: string
  viewAllHref?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 id={id} className="font-headline text-xl font-bold tracking-tight sm:text-2xl">
        {title}
      </h2>
      {viewAllHref !== undefined && (
        <a
          href={viewAllHref}
          className="shrink-0 text-sm font-medium text-primary hover:underline"
        >
          {t('storefront.viewAll')} ›
        </a>
      )}
    </div>
  )
}
