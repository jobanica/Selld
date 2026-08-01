import { useTranslation } from 'react-i18next'

import { formatPHP, fromDb } from '@/lib/money'
import { cn } from '@/lib/utils'

import type { Breakdown, TrendMonth } from './analytics-api'

/**
 * The two panels under the KPI row.
 *
 * Both are CSS — grid, flex and a width percentage — rather than a charting
 * library. Recharts is ~90KB gzipped for two panels that draw rectangles, and
 * the dashboard chunk is already the largest thing this project ships. Bars that
 * are real DOM elements also come with labels a screen reader can read, which a
 * canvas chart does not.
 */

/** `2026-08-01` -> `Aug`. Manila is the store's timezone everywhere else too. */
function monthLabel(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
  return Number.isNaN(parsed.getTime())
    ? iso.slice(0, 7)
    : parsed.toLocaleDateString('en-PH', { month: 'short', timeZone: 'UTC' })
}

export function TrendPanel({ months }: { months: TrendMonth[] }) {
  const { t } = useTranslation()
  // Oldest first, so the eye reads left to right into the present.
  const series = [...months].reverse().slice(-6)
  const peak = Math.max(1, ...series.map((m) => m.revenue))

  return (
    <section className="flex flex-col rounded-xl border bg-card p-4 sm:p-5">
      <header className="mb-1">
        <h2 className="font-headline text-base font-bold tracking-tight">
          {t('analytics.trendTitle')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('analytics.trendSubtitle')}</p>
      </header>

      {series.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('analytics.noData')}</p>
      ) : (
        <ul className="mt-5 flex h-44 items-end gap-2 sm:gap-3">
          {series.map((month) => {
            const height = Math.max(4, Math.round((month.revenue / peak) * 100))
            return (
              <li key={month.month} className="flex h-full flex-1 flex-col justify-end gap-2">
                <span className="text-center text-[10px] font-medium tabular-nums text-muted-foreground">
                  {month.orders}
                </span>
                <div
                  className="w-full rounded-t-md bg-primary/85 transition-[height]"
                  style={{ height: `${String(height)}%` }}
                  role="img"
                  aria-label={`${month.month}: ${formatPHP(fromDb(month.revenue))}, ${String(month.orders)}`}
                />
                {/* `month` is an ISO date like 2026-08-01; slicing to "08-01"
                    reads as a day. Show the month name instead. */}
                <span className="text-center text-[11px] text-muted-foreground">
                  {monthLabel(month.month)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Where the money came from, as horizontal bars.
 *
 * Channel rather than a funnel: Selld has no onboarding funnel to draw, and the
 * question a seller actually asks — "is Facebook or the shop making me money" —
 * has an answer in this data.
 */
export function ChannelPanel({ breakdown }: { breakdown: Breakdown | undefined }) {
  const { t } = useTranslation()
  const rows = (breakdown?.byChannel ?? []).slice(0, 6)
  const peak = Math.max(1, ...rows.map((r) => r.revenue))

  return (
    <section className="flex flex-col rounded-xl border bg-card p-4 sm:p-5">
      <header className="mb-1">
        <h2 className="font-headline text-base font-bold tracking-tight">
          {t('analytics.channelTitle')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('analytics.channelSubtitle')}</p>
      </header>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('analytics.noData')}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((row, index) => (
            <li key={row.channel} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium capitalize">{row.channel}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatPHP(fromDb(row.revenue))}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', index === 0 ? 'bg-primary' : 'bg-primary/50')}
                    style={{ width: `${String(Math.max(3, Math.round((row.revenue / peak) * 100)))}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {t('analytics.ordersCount', { count: row.orders })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
