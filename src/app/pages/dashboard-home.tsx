import { useQuery } from '@tanstack/react-query'
import { Banknote, PackageCheck, ShoppingBag, Truck, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import {
  fetchBreakdown,
  fetchCommissionKept,
  fetchProfit,
  fetchTrends,
  percentChange,
  previousWindow,
} from '@/features/analytics/analytics-api'
import { ChannelPanel, TrendPanel } from '@/features/analytics/dashboard-panels'
import { StatCard } from '@/features/analytics/stat-card'
import { SetupChecklist } from '@/features/onboarding/setup-checklist'
import { fetchOrders, type OrderRow } from '@/features/orders/orders-api'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'
import { cn } from '@/lib/utils'

/**
 * The home screen.
 *
 * Phase 0 shipped this with zeroed metrics from real formatters. Phase 18 made
 * them real, and made **profit** lead rather than revenue — that is the whole
 * argument of the phase in one tile, because revenue is the number every
 * marketplace already shows a seller and the one that lets them believe a losing
 * month was a good one.
 *
 * The layout is the dense KPI-row-then-panels shape of a modern analytics
 * dashboard, with one rule applied throughout: **every number is measured, or it
 * is absent.** The "vs last month" chips come from a second real query over the
 * previous window and disappear entirely when that window had nothing in it. A
 * dashboard whose deltas are decoration teaches a seller to ignore all of them,
 * including the ones that matter.
 */
export function DashboardHome() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  // 30 days, and the 30 before it. Monthly rather than weekly because a social
  // seller's week is lumpy — a payday weekend against a dead one is noise
  // dressed up as a trend.
  const windows = previousWindow(30)

  const profit = useQuery({
    queryKey: ['analytics-profit', tenant.id, windows.current.from],
    queryFn: () => fetchProfit(tenant.id, windows.current),
  })
  const before = useQuery({
    queryKey: ['analytics-profit-prev', tenant.id, windows.previous.from],
    queryFn: () => fetchProfit(tenant.id, windows.previous),
  })
  const commission = useQuery({
    queryKey: ['analytics-commission', tenant.id],
    queryFn: () => fetchCommissionKept(tenant.id),
  })
  const trends = useQuery({
    queryKey: ['analytics-trends', tenant.id],
    queryFn: () => fetchTrends(tenant.id),
  })
  const breakdown = useQuery({
    queryKey: ['analytics-breakdown', tenant.id],
    queryFn: () => fetchBreakdown(tenant.id),
  })
  const recent = useQuery({
    queryKey: ['dashboard-recent-orders', tenant.id],
    queryFn: () => fetchOrders({ tenantId: tenant.id, view: 'all', limit: 6 }),
  })

  const p = profit.data
  const q = before.data
  const money = (value: number | undefined) =>
    value === undefined ? '—' : formatPHP(fromDb(value))
  const delta = (current: number | undefined, previous: number | undefined) =>
    current === undefined || previous === undefined ? null : percentChange(current, previous)

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-headline text-2xl font-bold tracking-tight sm:text-3xl">
            {t('dashboard.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatManilaDate(new Date())} · {t('app.tagline')}
          </p>
        </div>
        <Link
          to="/analytics"
          className="inline-flex h-11 items-center rounded-full border px-4 text-sm font-medium hover:bg-accent"
        >
          {t('nav.analytics')}
        </Link>
      </header>

      {/* Above the KPI row, and only until it is done. A store with no products
          has no profit to read, and telling it so is more use than four zeroes. */}
      <SetupChecklist />

      <section aria-label={t('dashboard.title')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('dashboard.metricProfit')}
          value={money(p?.profit)}
          hint={t('dashboard.metricProfitHint')}
          icon={Wallet}
          tone={(p?.profit ?? 0) >= 0 ? 'positive' : 'negative'}
          delta={delta(p?.profit, q?.profit)}
          emphasis
        />
        <StatCard
          label={t('dashboard.metricRevenue')}
          value={money(p?.revenue)}
          icon={Banknote}
          delta={delta(p?.revenue, q?.revenue)}
        />
        <StatCard
          label={t('dashboard.metricOrders')}
          value={p === undefined ? '—' : String(p.orders)}
          icon={ShoppingBag}
          delta={delta(p?.orders, q?.orders)}
        />
        <StatCard
          label={t('dashboard.metricInFlight')}
          value={money(p?.inFlight)}
          hint={t('dashboard.metricInFlightHint')}
          icon={Truck}
          iconTone="warning"
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <TrendPanel months={trends.data ?? []} />
        </div>
        <div className="lg:col-span-2">
          <ChannelPanel breakdown={breakdown.data} />
        </div>
      </section>

      {/* The retention argument from the offer doc, kept beside a profit figure
          that is willing to be negative — it is only credible there. */}
      <Link to="/analytics" className="block rounded-xl focus-visible:outline-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-primary/5 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <PackageCheck className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold">{t('dashboard.metricCommissionKept')}</p>
              <p className="text-xs text-muted-foreground">
                {t('dashboard.metricCommissionKeptHint')}
              </p>
            </div>
          </div>
          <p className="font-headline text-2xl font-bold tabular-nums text-primary">
            {money(commission.data?.kept)}
          </p>
        </div>
      </Link>

      <RecentOrders rows={recent.data?.orders ?? []} />
    </div>
  )
}

/**
 * The latest orders.
 *
 * A stack of rows rather than a column-per-field table, at every width. A table
 * scrolled sideways on a 390px screen is a table a seller reads one column at a
 * time, and the point of this block is the glance.
 */
function RecentOrders({ rows }: { rows: OrderRow[] }) {
  const { t } = useTranslation()

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <h2 className="font-headline text-base font-bold tracking-tight">
          {t('analytics.recentOrders')}
        </h2>
        <Link to="/orders" className="text-sm font-medium text-primary hover:underline">
          {t('analytics.viewAllOrders')}
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          {t('analytics.noOrdersYet')}
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to="/orders"
                className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-accent/50"
              >
                <span
                  aria-hidden="true"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                >
                  {row.contactName.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{row.contactName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.orderNumber}
                    {row.city === null ? '' : ` · ${row.city}`}
                  </span>
                </span>
                <StatusPill status={row.fulfillmentStatus} />
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatPHP(fromDb(row.grandTotal))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StatusPill({ status }: { status: OrderRow['fulfillmentStatus'] }) {
  const { t } = useTranslation()
  const tone: Record<OrderRow['fulfillmentStatus'], string> = {
    pending: 'bg-warning/15 text-warning',
    confirmed: 'bg-primary/15 text-primary',
    packed: 'bg-primary/15 text-primary',
    shipped: 'bg-muted text-muted-foreground',
    delivered: 'bg-success/15 text-success',
    rts: 'bg-destructive/15 text-destructive',
    cancelled: 'bg-muted text-muted-foreground',
  }
  return (
    <span
      className={cn(
        'hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline',
        tone[status],
      )}
    >
      {t(`orders.status.${status}` as 'orders.status.pending')}
    </span>
  )
}
