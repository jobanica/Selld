import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { createI18nInstance, type Locale } from '@/lib/i18n'

import type { TrackingPayload } from '../cart-data'
import { StorefrontProvider } from '../storefront-provider'
import type { Store } from '../storefront-data'
import { TrackingPage } from './tracking-page'

/**
 * The vocabularies this page has to speak, copied from the database on purpose.
 *
 * `orders.fulfillment_status` is a CHECK constraint and `shipment_events.status`
 * comes from `shipment_status_map`, both in
 * `supabase/migrations/20260730001500_tracking.sql`. Nothing in TypeScript knows
 * about either, so the duplication here *is* the guard: a status the database can
 * produce and the locale files cannot name renders as a raw code on a buyer's
 * phone, and nothing warns. That is exactly how `picked up` first shipped —
 * lowercase, unpunctuated, in the middle of a Taglish timeline.
 */
const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'rts',
  'cancelled',
] as const

const COURIER_STATUSES = [
  'booked',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'cancelled',
  'unknown',
] as const

/*
 * No `as unknown as Store` here any more.
 *
 * The cast used to stand in for `customDomain`, and it went on quietly standing
 * in for every field added since — so when `hours` and `payments` joined the
 * type, six tests failed at runtime with "cannot read properties of undefined"
 * rather than at the compiler, which is where a fixture is supposed to fail. A
 * fixture that opts out of the type is a fixture that stops testing the thing.
 */
const STORE: Store = {
  id: 'store-1',
  name: "Rhea's Finds",
  slug: 'rheas-finds',
  customDomain: null,
  logoPath: null,
  brandColor: '#b91c5c',
  locale: 'tl',
  theme: {},
  hours: {
    days: [
      { open: '09:00', close: '18:00' },
      { open: '09:00', close: '18:00' },
      { open: '09:00', close: '18:00' },
      { open: '09:00', close: '18:00' },
      { open: '09:00', close: '18:00' },
      { open: '09:00', close: '18:00' },
      null,
    ],
    note: '',
    openNow: true,
  },
  payments: { cod: true, online: false, methods: [] },
}

function payload(overrides: Partial<TrackingPayload> = {}): TrackingPayload {
  return {
    orderNumber: '0001',
    placedAt: '2026-07-30T02:00:00Z',
    status: 'shipped',
    paymentStatus: 'unpaid',
    firstName: 'Jasmine',
    city: 'Davao City',
    store: { name: "Rhea's Finds", slug: 'rheas-finds' },
    courier: 'jnt',
    waybill: 'JT2607310001',
    events: [
      {
        status: 'in_transit',
        description: 'Departed sorting centre',
        location: 'Davao Sorting Hub',
        occurredAt: '2026-07-30T08:00:00Z',
      },
    ],
    ...overrides,
  }
}

function draw(data: TrackingPayload | null, locale: Locale = 'en') {
  return render(
    <I18nextProvider i18n={createI18nInstance(locale)}>
      <StorefrontProvider
        value={{
          store: STORE,
          storageOrigin: '',
          origin: 'http://x',
          basePath: '',
          cartCount: 0,
          cartBump: false,
        }}
      >
        <TrackingPage data={data} />
      </StorefrontProvider>
    </I18nextProvider>,
  )
}

describe('TrackingPage', () => {
  it('answers the question the buyer would otherwise message the seller about', () => {
    draw(payload())

    expect(screen.getByText('0001')).toBeTruthy()
    expect(screen.getByText('JT2607310001')).toBeTruthy()
    expect(screen.getByText(/Picked up by the courier/)).toBeTruthy()
    expect(screen.getByText('Departed sorting centre')).toBeTruthy()
  })

  it('shows the first name and city, which is all it is given', () => {
    const { container } = draw(payload())
    expect(container.textContent).toContain('Jasmine')
    expect(container.textContent).toContain('Davao City')
  })

  /**
   * The `tl` half of this is weaker than it looks and that is fine: i18next falls
   * back to `en` for a missing Taglish key, so this loop passes with `tl` gutted.
   * What catches that is the type — `tl.ts` is declared as `Translations`, so a
   * missing key is a compile error, verified by deleting one.
   */
  it('names every status the database can produce, in both locales', () => {
    for (const locale of ['en', 'tl'] as const) {
      for (const status of ORDER_STATUSES) {
        const { container, unmount } = draw(payload({ status, events: [] }), locale)
        // Two distinct failures, two distinct symptoms. A status missing from
        // STATUS_KEYS falls through to the raw value with its underscores turned
        // to spaces; a status that is in STATUS_KEYS but absent from the locale
        // file renders as i18next's key echo. Neither warns at runtime.
        expect(container.textContent).not.toContain(status.replace(/_/g, ' '))
        expect(container.textContent).not.toContain('tracking.')
        unmount()
      }

      for (const status of COURIER_STATUSES) {
        const { container, unmount } = draw(
          payload({
            events: [{ status, description: null, location: null, occurredAt: '2026-07-30T08:00:00Z' }],
          }),
          locale,
        )
        expect(container.textContent).not.toContain(status.replace(/_/g, ' '))
        expect(container.textContent).not.toContain('tracking.')
        unmount()
      }
    }
  })

  it('falls back to the courier’s own word rather than a missing key', () => {
    // Couriers add scan codes without telling anyone. Rough English beats
    // `tracking.status.mp_s060` on a buyer's screen.
    const { container } = draw(
      payload({
        events: [
          { status: 'held_at_customs', description: null, location: null, occurredAt: '2026-07-30T08:00:00Z' },
        ],
      }),
    )
    expect(container.textContent).toContain('held at customs')
    expect(container.textContent).not.toContain('tracking.status')
  })

  it('does not draw a progress bar for a parcel coming back', () => {
    const { queryByLabelText } = draw(payload({ status: 'rts' }))
    expect(queryByLabelText('Delivery progress')).toBeNull()
  })

  it('says so, in the store’s own branding, when the number is wrong', () => {
    const { container } = draw(null)
    expect(container.textContent).toContain('We could not find that order')
    // Still the shop: a bare error page reads as "you have left the store", and
    // the buyer goes back to messaging the seller.
    expect(container.textContent).toContain("Rhea's Finds")
  })
})
