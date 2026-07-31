import { PackageSearch } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatManilaDateTime } from '@/lib/time/manila'

import type { TrackingPayload } from '../cart-data'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'

/**
 * "Nasaan na po order ko", answered before it is asked.
 *
 * Public, no login. That is the whole point: a buyer who has to remember a password
 * will message the seller instead, which is the behaviour this phase exists to
 * remove. The trade is that the order number becomes a capability, so the page is
 * deliberately thin — status, a timeline, the courier and the waybill. No address,
 * no phone, no line items, no totals. A leaked order number should be worth nothing.
 *
 * Server-rendered like the rest of the storefront, so it opens from an SMS link on a
 * cold 3G connection without waiting for JavaScript. This is the page a buyer taps
 * while standing outside, and it must be readable before anything hydrates.
 */
export function TrackingPage({ data }: { data: TrackingPayload | null }) {
  const { t } = useTranslation()

  if (data === null) {
    return (
      <>
        <StoreHeader showSearch={false} />
        <main className="mx-auto w-full max-w-2xl px-4 pb-16">
          <div className="mt-8 rounded-xl border border-dashed py-16 text-center">
            <span
              aria-hidden="true"
              className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"
            >
              <PackageSearch className="size-6" />
            </span>
            <p className="font-medium">{t('tracking.notFound')}</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
              {t('tracking.notFoundHint')}
            </p>
          </div>
        </main>
        <StoreFooter />
      </>
    )
  }

  const reached = progressIndex(data.status)
  // A returned or cancelled parcel is not partway along the four steps — it left
  // them. Showing a half-filled progress bar there reads as "still coming".
  const stalled = data.status === 'cancelled' || data.status === 'rts'

  /**
   * A courier status in the buyer's language, or the courier's own word for it.
   *
   * The fallback matters: couriers add codes without telling anyone, and a status
   * that has not reached the locale files yet should read as slightly rough
   * English rather than as `tracking.status.mp_s060`.
   */
  const statusLabel = (status: string): string => {
    const key = STATUS_KEYS[status as keyof typeof STATUS_KEYS]
    return key === undefined ? status.replace(/_/g, ' ') : t(key)
  }

  return (
    <>
      <StoreHeader showSearch={false} />

      <main className="mx-auto w-full max-w-2xl px-4 pb-16">
        <div className="flex flex-col items-center gap-1 py-6 text-center">
          <h1 className="font-headline text-xl font-bold tracking-tight sm:text-2xl">
            {t('tracking.title')}
          </h1>
          {/* First name and destination city only: enough for the right person to
              recognise their own parcel, useless to anyone else. */}
          <p className="text-sm text-muted-foreground">
            {t('tracking.forWhom', { name: data.firstName, city: data.city ?? '' })}
          </p>
          {/* Selectable and large, because the next thing a buyer does with it is
              read it out to the seller. */}
          <p className="mt-2 select-all text-2xl font-bold tracking-tight tabular">
            {data.orderNumber}
          </p>
          <p className="text-xs text-muted-foreground">{formatManilaDateTime(data.placedAt)}</p>
        </div>

        <p
          className={`rounded-xl border p-4 text-center text-lg font-semibold ${
            stalled ? 'bg-muted' : 'border-primary/30 bg-primary/10 text-primary'
          }`}
        >
          {statusLabel(data.status)}
        </p>

        {/* A progress bar as well as the list. The single most common question is
            "how far along is it", and a buyer should be able to answer that at a
            glance without reading courier jargon. */}
        {!stalled && (
          <ol className="mt-4 flex items-start gap-1.5" aria-label={t('tracking.progress')}>
            {STEPS.map((step, index) => (
              <li key={step} className="flex flex-1 flex-col gap-1.5">
                <span
                  className={`h-1.5 rounded-full ${index <= reached ? 'bg-primary' : 'bg-muted'}`}
                  aria-hidden="true"
                />
                <span
                  className={`text-[11px] leading-tight ${
                    index <= reached ? 'font-medium' : 'text-muted-foreground'
                  }`}
                >
                  {t(STEP_KEYS[step])}
                </span>
              </li>
            ))}
          </ol>
        )}

        {data.waybill !== null && (
          <p className="mt-4 rounded-xl border p-4 text-sm">
            <span className="block text-xs uppercase tracking-wide text-muted-foreground">
              {t('tracking.waybill', { courier: courierName(data.courier) })}
            </span>
            <span className="select-all font-medium tabular">{data.waybill}</span>
          </p>
        )}

        <section className="mt-4 rounded-xl border p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('tracking.history')}</h2>
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tracking.noEventsYet')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {data.events.map((event, index) => (
                <li key={`${event.occurredAt}-${index}`} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      index === 0 ? 'bg-primary' : 'bg-muted-foreground/40'
                    }`}
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium">{statusLabel(event.status)}</span>
                    {event.description !== null && event.description !== '' && (
                      <span className="block text-muted-foreground">{event.description}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {formatManilaDateTime(event.occurredAt)}
                      {event.location === null || event.location === ''
                        ? ''
                        : ` · ${event.location}`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('tracking.askStore', { store: data.store.name })}
        </p>

        <a
          href="/"
          className="mx-auto mt-4 inline-flex h-11 items-center rounded-full border px-5 text-sm font-medium"
        >
          {t('cart.startShopping')}
        </a>
      </main>

      <StoreFooter />
    </>
  )
}

/** The four steps a buyer is shown. Courier detail lives in the timeline below. */
const STEPS = ['confirmed', 'packed', 'shipped', 'delivered'] as const

/**
 * Literal keys, spelled out.
 *
 * A template literal built from the status would type-check as `string` and lose
 * key checking entirely — the same trap the onboarding copy hit in phase 3.
 */
const STEP_KEYS = {
  confirmed: 'tracking.step.confirmed',
  packed: 'tracking.step.packed',
  shipped: 'tracking.step.shipped',
  delivered: 'tracking.step.delivered',
} as const

/**
 * Two vocabularies, one lookup.
 *
 * The headline reads `orders.fulfillment_status` (pending…rts) while the timeline
 * reads `shipment_events.status` (the courier vocabulary in
 * `shipment_status_map`). They overlap but are not the same list, and a key
 * missing from either shows the raw value to a buyer — which is how `picked up`
 * first appeared on this page in lowercase with no explanation.
 */
const STATUS_KEYS = {
  // Order statuses.
  pending: 'tracking.status.pending',
  confirmed: 'tracking.status.confirmed',
  packed: 'tracking.status.packed',
  shipped: 'tracking.status.shipped',
  rts: 'tracking.status.rts',
  // Courier statuses.
  booked: 'tracking.status.booked',
  picked_up: 'tracking.status.picked_up',
  in_transit: 'tracking.status.in_transit',
  out_for_delivery: 'tracking.status.out_for_delivery',
  delivery_failed: 'tracking.status.delivery_failed',
  returning: 'tracking.status.returning',
  returned: 'tracking.status.returned',
  unknown: 'tracking.status.unknown',
  // Shared by both.
  delivered: 'tracking.status.delivered',
  cancelled: 'tracking.status.cancelled',
} as const

function courierName(courier: string | null): string {
  if (courier === 'jnt') return 'J&T Express'
  if (courier === 'flash') return 'Flash Express'
  return courier === null ? '' : courier.toUpperCase()
}

/** How far along the four visible steps this order is. */
function progressIndex(status: string): number {
  switch (status) {
    case 'pending':
    case 'confirmed':
      return 0
    case 'packed':
      return 1
    case 'delivered':
      return 3
    // Everything else — shipped, and every courier status short of delivered —
    // is "on its way". Default rather than enumerated, so a courier status this
    // page has never seen still lands somewhere sensible.
    default:
      return 2
  }
}
