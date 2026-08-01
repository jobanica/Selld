import { useQuery } from '@tanstack/react-query'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { fetchCommissionKept, fetchProfit } from '@/features/analytics/analytics-api'
import { SetupChecklist } from '@/features/onboarding/setup-checklist'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

/**
 * The home screen.
 *
 * Phase 0 shipped this with zeroed metrics from real formatters — deliberately,
 * so it could not be mistaken for working data. Phase 18 makes them real, and
 * changes what leads: not revenue, but **profit**.
 *
 * That is the whole argument of the phase in one tile. Revenue is the number
 * every marketplace already shows a seller, and it is the number that lets them
 * believe a losing month was a good one. The commission-kept tile sits beside it
 * because it is the retention mechanic from the offer doc — the reason to keep
 * paying for this rather than going back to a marketplace — and it is only
 * credible next to a profit figure that is willing to be negative.
 */
export function DashboardHome() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const profit = useQuery({
    queryKey: ['analytics-profit', tenant.id],
    queryFn: () => fetchProfit(tenant.id),
  })
  const commission = useQuery({
    queryKey: ['analytics-commission', tenant.id],
    queryFn: () => fetchCommissionKept(tenant.id),
  })

  const p = profit.data
  const made = (p?.profit ?? 0) >= 0
  const money = (value: number | undefined) =>
    value === undefined ? '—' : formatPHP(fromDb(value))

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {formatManilaDate(new Date())} · {t('app.tagline')}
        </p>
      </header>

      {/* Above the profit tile, and only until it is done. A store with no
          products has no profit to read, and telling it so is less useful than
          telling it what to do next. */}
      <SetupChecklist />

      {/* Profit first, and it is a link: the number is an invitation to see the
          arithmetic, which is where the seller settles whether to believe it. */}
      <Link to="/analytics" className="block rounded-xl focus-visible:outline-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('dashboard.metricProfit')}</CardDescription>
            <CardTitle
              id="home-profit"
              className={`flex items-center gap-2 text-3xl tabular-nums ${
                made ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
              }`}
            >
              {made ? (
                <TrendingUp className="size-6 shrink-0" aria-hidden="true" />
              ) : (
                <TrendingDown className="size-6 shrink-0" aria-hidden="true" />
              )}
              {money(p?.profit)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs leading-snug text-muted-foreground">
              {t('dashboard.metricProfitHint')}
            </p>
          </CardContent>
        </Card>
      </Link>

      <section
        aria-label={t('dashboard.title')}
        className="grid grid-cols-2 items-start gap-3 lg:grid-cols-4"
      >
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">
              {t('dashboard.metricCommissionKept')}
            </CardDescription>
            <CardTitle id="home-commission" className="text-xl tabular-nums sm:text-2xl">
              {money(commission.data?.kept)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs leading-snug text-muted-foreground">
              {t('dashboard.metricCommissionKeptHint')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t('dashboard.metricRevenue')}</CardDescription>
            <CardTitle className="text-xl tabular-nums sm:text-2xl">
              {money(p?.revenue)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t('dashboard.metricOrders')}</CardDescription>
            <CardTitle className="text-xl tabular-nums sm:text-2xl">{p?.orders ?? '—'}</CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t('dashboard.metricInFlight')}</CardDescription>
            <CardTitle className="text-xl tabular-nums sm:text-2xl">
              {money(p?.inFlight)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs leading-snug text-muted-foreground">
              {t('dashboard.metricInFlightHint')}
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
