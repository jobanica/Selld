import { ShoppingBag } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { storeHref } from '@/lib/tenant/resolve-tenant'
import { cn } from '@/lib/utils'

import { useStorageUrl, useStoreHref, useStorefront } from '../use-storefront'
import { StoreOpenBadge } from './store-info'

/**
 * Store header.
 *
 * The search box is a plain GET form and the category chips are plain links, so
 * both work before any JavaScript has run — which on a 3G connection is most of
 * the time that matters. Wiring them to React state would have meant the buyer's
 * first tap does nothing until hydration finishes.
 */
export function StoreHeader({
  categories = [],
  activeCategory = null,
  search = '',
  showSearch = true,
}: {
  categories?: { name: string; slug: string; count: number }[]
  activeCategory?: string | null
  search?: string
  showSearch?: boolean
}) {
  const { t } = useTranslation()
  const { store, cartCount, cartBump, basePath } = useStorefront()
  const href = useStoreHref()
  const toUrl = useStorageUrl()
  const logo = toUrl(store.logoPath)

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <a href={href('/')} className="flex min-w-0 items-center gap-2.5">
          {logo === null ? (
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
            >
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <img
              src={logo}
              alt=""
              width={36}
              height={36}
              className="size-9 shrink-0 rounded-lg object-cover"
            />
          )}
          <span className="truncate font-headline text-base font-semibold tracking-tight">
            {store.name}
          </span>
        </a>

        {/* Next to the name, because "open pa po kayo?" is the question a buyer
            asks before anything else — and it renders nothing at all for a store
            that has not published hours. */}
        <StoreOpenBadge hours={store.hours} />

        {showSearch && (
          <form action={href('/')} method="get" role="search" className="order-3 flex w-full min-w-0 basis-full sm:order-none sm:ml-auto sm:w-auto sm:basis-auto sm:max-w-md sm:flex-1">
            {/* Keep the category filter when searching within it. */}
            {activeCategory !== null && <input type="hidden" name="category" value={activeCategory} />}
            <label className="sr-only" htmlFor="store-search">
              {t('storefront.searchLabel')}
            </label>
            <input
              id="store-search"
              type="search"
              name="q"
              defaultValue={search}
              placeholder={t('storefront.searchPlaceholder')}
              // 44px min touch target, per the mobile-first rule.
              className="h-11 w-full rounded-full border bg-muted/50 px-4 text-sm focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          </form>
        )}

      {/*
        Cart. A plain link, so it works before hydration and is crawl-safe.

        `cart-bump` is the whole feedback loop for adding something. There is no
        client-side router here: "Add to cart" is a real POST and a redirect, so
        by the time the buyer sees anything they are back on the page they were
        already reading and the only evidence is this button. The animation is
        pure CSS and the class is server-rendered, so it plays on a phone that has
        not finished downloading the JavaScript — which is most phones, on the
        first visit, on mobile data.
      */}
        <a
          href={href('/cart')}
          className={cn(
            'relative grid size-11 shrink-0 place-items-center rounded-full hover:bg-accent',
            !showSearch && 'ml-auto',
            cartBump && 'cart-bump',
          )}
          aria-label={t('cart.openWithCount', { count: cartCount })}
        >
          <ShoppingBag className="size-5" aria-hidden="true" />
          {cartCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold leading-5 text-primary-foreground">
              {cartCount > 99 ? '99+' : cartCount}
            </span>
          )}
        </a>
      </div>

      {categories.length > 0 && (
        <nav aria-label={t('storefront.categoriesLabel')} className="border-t">
          <ul className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <CategoryChip href={buildUrl(basePath, null, search)} active={activeCategory === null}>
              {t('storefront.allProducts')}
            </CategoryChip>
            {categories.map((category) => (
              <CategoryChip
                key={category.slug}
                href={buildUrl(basePath, category.slug, search)}
                active={activeCategory === category.slug}
              >
                {category.name}
              </CategoryChip>
            ))}
          </ul>
        </nav>
      )}
    </header>
  )
}

function buildUrl(basePath: string, category: string | null, search: string): string {
  const params = new URLSearchParams()
  if (category !== null) params.set('category', category)
  if (search.trim() !== '') params.set('q', search.trim())
  const query = params.toString()
  const root = storeHref(basePath, '/')
  return query === '' ? root : `${root}?${query}`
}

function CategoryChip({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <li className="shrink-0">
      <a
        href={href}
        aria-current={active ? 'page' : undefined}
        className={
          active
            ? 'flex h-9 items-center rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground'
            : 'flex h-9 items-center rounded-full px-3.5 text-sm text-muted-foreground hover:bg-accent'
        }
      >
        {children}
      </a>
    </li>
  )
}
