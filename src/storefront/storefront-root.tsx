import { I18nextProvider } from 'react-i18next'

import { createI18nInstance, type Locale } from '@/lib/i18n'

import { HomePage } from './pages/home-page'
import { ProductPage } from './pages/product-page'
import { StoreNotFound } from './pages/store-not-found'
import type { PageData } from './storefront-data'
import { StorefrontProvider } from './storefront-provider'

export interface StorefrontRootProps {
  data: PageData
  storageOrigin: string
  origin: string
}

/**
 * The whole storefront tree, rendered identically on the server and in the
 * browser.
 *
 * There is no client-side router here, on purpose. Navigation is real `<a>`
 * links and the search box is a real GET form, so every page is a
 * server-rendered document a buyer can read before any JavaScript arrives — and
 * `react-router` never enters the buyer's bundle. It also means every URL is
 * independently crawlable and shareable, which is the point of a storefront.
 *
 * i18n uses a per-render instance rather than the shared singleton, because the
 * locale here belongs to the *store* (the seller chose it), and one server
 * process renders many stores.
 */
export function StorefrontRoot({ data, storageOrigin, origin }: StorefrontRootProps) {
  const store = data.route === 'not-found' ? data.store : data.payload.store
  const locale: Locale = store?.locale ?? 'en'
  const i18n = createI18nInstance(locale)

  const body =
    data.route === 'home' ? (
      <HomePage payload={data.payload} query={data.query} />
    ) : data.route === 'product' && data.payload.product !== null ? (
      <ProductPage payload={data.payload} />
    ) : (
      <StoreNotFound hostname={data.route === 'not-found' ? data.hostname : origin} />
    )

  return (
    <I18nextProvider i18n={i18n}>
      {store === null ? (
        body
      ) : (
        <StorefrontProvider value={{ store, storageOrigin, origin }}>{body}</StorefrontProvider>
      )}
    </I18nextProvider>
  )
}
