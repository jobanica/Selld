import { useTranslation } from 'react-i18next'

import type { OnlineMethod } from '@/lib/payments/online-methods'
import { formatTime12, summariseWeek, type WeekHours } from '@/lib/store-hours'

import type { StoreHoursPublic, StorePayments } from '../storefront-data'

/**
 * What the store publishes about how it trades: when it takes orders, and how a
 * buyer can pay.
 *
 * Both answer a question a buyer asks *before* they will type an address. "Open
 * pa po kayo?" is the single most common message in a social seller's inbox, and
 * "COD po ba?" is the second — and a shop that answers neither on the page is a
 * shop the buyer has to message instead of buying from.
 *
 * Nothing here is invented. A store with no published hours renders no hours, and
 * a method only appears when the seller switched it on *and* their payment
 * account can actually take it. An offered button that fails at the last step is
 * worse than one that was never there.
 */

/** Monday-first, so the label array below lines up with `WeekHours`. */
const DAY_KEYS = [
  'storefront.dayMon',
  'storefront.dayTue',
  'storefront.dayWed',
  'storefront.dayThu',
  'storefront.dayFri',
  'storefront.daySat',
  'storefront.daySun',
] as const

/**
 * The open/closed pill.
 *
 * `openNow` is read straight from the payload — the server decided it. See
 * `StoreHoursPublic`.
 */
export function StoreOpenBadge({ hours }: { hours: StoreHoursPublic | null }) {
  const { t } = useTranslation()
  if (hours === null) return null

  return (
    <span
      className={
        hours.openNow
          ? 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-success'
          : 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground'
      }
    >
      <span
        aria-hidden="true"
        className={
          hours.openNow
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground/60'
        }
      />
      {hours.openNow ? t('storefront.openNow') : t('storefront.closedNow')}
    </span>
  )
}

/** The whole week, collapsed into runs. */
export function StoreHoursList({ hours }: { hours: StoreHoursPublic }) {
  const { t } = useTranslation()
  const runs = summariseWeek(hours.days as unknown as WeekHours)

  return (
    <dl className="flex flex-col gap-1 text-xs">
      {runs.map((run) => (
        <div key={run.from} className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">
            {run.from === run.to
              ? t(DAY_KEYS[run.from] ?? 'storefront.dayMon')
              : `${t(DAY_KEYS[run.from] ?? 'storefront.dayMon')}–${t(DAY_KEYS[run.to] ?? 'storefront.daySun')}`}
          </dt>
          <dd className={run.hours === null ? 'text-muted-foreground' : 'font-medium text-foreground'}>
            {run.hours === null
              ? t('storefront.closed')
              : `${formatTime12(run.hours.open)} – ${formatTime12(run.hours.close)}`}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * "We accept" — COD and whatever online methods are live.
 *
 * The names are hardcoded brand names rather than translated strings: GCash is
 * GCash in both locales, and a buyer scans for the logo-word they know.
 */
export function StorePaymentList({
  payments,
  className,
}: {
  payments: StorePayments
  className?: string
}) {
  const { t } = useTranslation()
  const labels: string[] = []
  if (payments.cod) labels.push(t('storefront.payCod'))
  for (const method of payments.methods) labels.push(METHOD_LABELS[method])

  if (labels.length === 0) return null

  return (
    <ul className={className ?? 'flex flex-wrap items-center gap-1.5'}>
      {labels.map((label) => (
        <li
          key={label}
          className="rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground"
        >
          {label}
        </li>
      ))}
    </ul>
  )
}

const METHOD_LABELS: Record<OnlineMethod, string> = {
  gcash: 'GCash',
  maya: 'Maya',
  grabpay: 'GrabPay',
  qrph: 'QR Ph',
  card: 'Card',
}
