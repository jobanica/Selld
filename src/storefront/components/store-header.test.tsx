import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { createI18nInstance } from '@/lib/i18n'

import type { Store } from '../storefront-data'
import { StorefrontProvider } from '../storefront-provider'
import { StoreHeader } from './store-header'

const STORE: Store = {
  id: 'store-1',
  name: "Rhea's Finds",
  slug: 'rheas-finds',
  customDomain: null,
  logoPath: null,
  brandColor: null,
  locale: 'en',
  theme: {},
  hours: null,
  payments: { cod: true, online: false, methods: [] },
}

function draw({ cartCount = 0, cartBump = false }: { cartCount?: number; cartBump?: boolean }) {
  return render(
    <I18nextProvider i18n={createI18nInstance('en')}>
      <StorefrontProvider
        value={{
          store: STORE,
          storageOrigin: '',
          origin: 'http://x',
          basePath: '/store/rheas-finds',
          cartCount,
          cartBump,
        }}
      >
        <StoreHeader />
      </StorefrontProvider>
    </I18nextProvider>,
  )
}

/**
 * The cart button is the only feedback a buyer gets for adding something.
 *
 * There is no client-side router here: "Add to cart" is a POST and a redirect
 * back to the page they were already reading, so if this button says nothing,
 * the buyer's reasonable conclusion is that it did not work. It said nothing for
 * a long time — the server passed `cartCount` on the cart and checkout routes
 * only, and left the catalog pages at the default of 0.
 */
describe('StoreHeader cart button', () => {
  it('shows the number of items in the cart', () => {
    draw({ cartCount: 3 })
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('shows nothing at all for an empty cart', () => {
    const { container } = draw({ cartCount: 0 })
    const link = container.querySelector('a[href$="/cart"]')
    expect(link?.textContent).toBe('')
  })

  it('caps the badge rather than breaking the circle', () => {
    draw({ cartCount: 250 })
    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('counts in the accessible name too, not just the badge', () => {
    // A badge is a visual affordance. Someone using a screen reader gets the
    // number from the label or not at all.
    draw({ cartCount: 3 })
    expect(screen.getByRole('link', { name: /3/ })).toBeTruthy()
  })

  it('animates on the render that follows an add, and only that one', () => {
    const { container: bumped } = draw({ cartCount: 1, cartBump: true })
    expect(bumped.querySelector('a[href$="/cart"]')?.className).toContain('cart-bump')

    const { container: calm } = draw({ cartCount: 1, cartBump: false })
    expect(calm.querySelector('a[href$="/cart"]')?.className).not.toContain('cart-bump')
  })

  it('keeps the cart link inside the store when mounted on a path', () => {
    const { container } = draw({ cartCount: 1 })
    expect(container.querySelector('a[href$="/cart"]')?.getAttribute('href')).toBe(
      '/store/rheas-finds/cart',
    )
  })
})
