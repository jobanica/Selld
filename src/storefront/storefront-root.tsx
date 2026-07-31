import { I18nextProvider } from 'react-i18next'

import { createI18nInstance, type Locale } from '@/lib/i18n'

import type { CartPageData } from './cart-data'
import { CartPage } from './pages/cart-page'
import { CheckoutPage } from './pages/checkout-page'
import { HomePage } from './pages/home-page'
import { OrderConfirmedPage } from './pages/order-confirmed-page'
import { ProductPage } from './pages/product-page'
import { StoreNotFound } from './pages/store-not-found'
import { TrackingPage } from './pages/tracking-page'
import type { PageData } from './storefront-data'
import { StorefrontProvider } from './storefront-provider'

/**
 * Catalog pages and cart pages share this tree.
 *
 * They are separate unions rather than one because they come from different
 * sources: catalog pages are one jsonb document from a single RPC, cart pages are
 * assembled from the cart token. Keeping them apart means a catalog page cannot
 * accidentally require a cart, and the cart pages carry no store payload they do
 * not need.
 */
export type StorefrontPage = PageData | CartPageData

export interface StorefrontRootProps {
  data: StorefrontPage
  storageOrigin: string
  origin: string
  /** Item count for the header badge; cart pages carry their own. */
  cartCount?: number
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
export function StorefrontRoot({
  data,
  storageOrigin,
  origin,
  cartCount = 0,
}: StorefrontRootProps) {
  const store = storeOf(data)
  const locale: Locale = store?.locale ?? 'en'
  const i18n = createI18nInstance(locale)

  const body =
    data.route === 'home' ? (
      <HomePage payload={data.payload} query={data.query} />
    ) : data.route === 'product' && data.payload.product !== null ? (
      <ProductPage payload={data.payload} />
    ) : data.route === 'cart' ? (
      <CartPage quote={data.quote} />
    ) : data.route === 'checkout' ? (
      <CheckoutPage data={data} />
    ) : data.route === 'order-confirmed' ? (
      <OrderConfirmedPage receipt={data.receipt} />
    ) : data.route === 'track' ? (
      <TrackingPage data={data.tracking} />
    ) : (
      <StoreNotFound hostname={data.route === 'not-found' ? data.hostname : origin} />
    )

  return (
    <I18nextProvider i18n={i18n}>
      {store === null ? (
        body
      ) : (
        <StorefrontProvider value={{ store, storageOrigin, origin, cartCount }}>
          {body}
        </StorefrontProvider>
      )}
    </I18nextProvider>
  )
}

/**
 * The store, wherever this page keeps it.
 *
 * Cart pages have no store payload of their own — they are reached by cookie, not
 * by a catalog query — so the server passes the branding in separately. Returning
 * null here would render the cart unbranded, which is how a buyer decides they have
 * left the shop they were buying from.
 */
function storeOf(data: StorefrontPage) {
  if (data.route === 'not-found') return data.store
  if (data.route === 'home' || data.route === 'product') return data.payload.store
  return data.store ?? null
}
