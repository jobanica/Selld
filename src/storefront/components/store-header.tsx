import { useTranslation } from 'react-i18next'

import { useStorageUrl, useStorefront } from '../use-storefront'

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
  const { store } = useStorefront()
  const toUrl = useStorageUrl()
  const logo = toUrl(store.logoPath)

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
        <a href="/" className="flex min-w-0 items-center gap-2.5">
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

        {showSearch && (
          <form action="/" method="get" role="search" className="ml-auto flex min-w-0 flex-1 justify-end">
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
              className="h-11 w-full max-w-[10rem] rounded-full border bg-background px-4 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:max-w-xs"
            />
          </form>
        )}
      </div>

      {categories.length > 0 && (
        <nav aria-label={t('storefront.categoriesLabel')} className="border-t">
          <ul className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <CategoryChip href={buildUrl(null, search)} active={activeCategory === null}>
              {t('storefront.allProducts')}
            </CategoryChip>
            {categories.map((category) => (
              <CategoryChip
                key={category.slug}
                href={buildUrl(category.slug, search)}
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

function buildUrl(category: string | null, search: string): string {
  const params = new URLSearchParams()
  if (category !== null) params.set('category', category)
  if (search.trim() !== '') params.set('q', search.trim())
  const query = params.toString()
  return query === '' ? '/' : `/?${query}`
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
