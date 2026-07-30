import { useTranslation } from 'react-i18next'

import { ProductCard } from '../components/product-card'
import { priorityAttrs } from '../image-config'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import type { HomePayload } from '../storefront-data'
import { useStorageUrl, useStorefront } from '../use-storefront'

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
  const { t } = useTranslation()
  const { store } = useStorefront()
  const toUrl = useStorageUrl()

  const hero = store.theme.hero ?? {}
  const heroImage = toUrl(hero.imagePath ?? null)
  const search = query.search ?? ''
  const isFiltered = query.category !== null || search.trim() !== ''

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
          <section className="relative my-4 overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-accent-brand/10 px-5 py-8 sm:px-8 sm:py-12">
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
            </div>
          </section>
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
                href="/"
                className="mt-4 inline-flex h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
              >
                {t('storefront.backToStore')}
              </a>
            )}
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {payload.products.map((product, index) => (
              <li key={product.id} className="flex">
                {/* Only the first card is eager: it is the LCP candidate, and
                    making the rest compete with it for 3G bandwidth is how an
                    image-heavy grid loses the budget. */}
                <ProductCard product={product} priority={index === 0} />
              </li>
            ))}
          </ul>
        )}
      </main>

      <StoreFooter />
    </>
  )
}
