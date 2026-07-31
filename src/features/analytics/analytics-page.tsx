import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Megaphone, TrendingDown, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import {
  describeAnalyticsError,
  fetchAdSpend,
  fetchBreakdown,
  fetchCommissionKept,
  fetchProfit,
  fetchTrends,
  recordAdSpend,
} from './analytics-api'

/**
 * Analytics & true profit.
 *
 * The screen answers one question in its first line — *kumita ba ako this
 * month, at magkano talaga* — and then shows its working. That order is the
 * whole design. A dashboard that opens with six tiles of revenue, orders, AOV
 * and units is asking the seller to do the subtraction themselves, which is
 * exactly what every marketplace already makes them do and exactly why they do
 * not know whether they are making money.
 *
 * The arithmetic is visible underneath because the first time this number is bad
 * news nobody believes it, and a profit figure you cannot check is a profit
 * figure you argue with instead of acting on.
 */
export function AnalyticsPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [spendDate, setSpendDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [spendPesos, setSpendPesos] = useState('')
  const [spendChannel, setSpendChannel] = useState('facebook')
  const [error, setError] = useState<string | null>(null)

  const profit = useQuery({
    queryKey: ['analytics-profit', tenant.id],
    queryFn: () => fetchProfit(tenant.id),
  })
  const commission = useQuery({
    queryKey: ['analytics-commission', tenant.id],
    queryFn: () => fetchCommissionKept(tenant.id),
  })
  const breakdown = useQuery({
    queryKey: ['analytics-breakdown', tenant.id],
    queryFn: () => fetchBreakdown(tenant.id),
  })
  const trends = useQuery({
    queryKey: ['analytics-trends', tenant.id],
    queryFn: () => fetchTrends(tenant.id, 6),
  })
  const adSpend = useQuery({
    queryKey: ['analytics-ads', tenant.id],
    queryFn: () => fetchAdSpend(tenant.id),
  })

  const addSpend = useMutation({
    mutationFn: () =>
      recordAdSpend({
        tenantId: tenant.id,
        spentOn: spendDate,
        pesos: Number(spendPesos || 0),
        channel: spendChannel,
      }),
    onSuccess: async () => {
      setSpendPesos('')
      setError(null)
      // Ad spend is a subtraction, so the headline changes the moment it lands.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['analytics-profit', tenant.id] }),
        queryClient.invalidateQueries({ queryKey: ['analytics-ads', tenant.id] }),
      ])
    },
    onError: (cause) => setError(describeAnalyticsError(cause)),
  })

  const p = profit.data
  const made = (p?.profit ?? 0) >= 0
  const coverage = p?.coverage.costedFraction ?? 1
  const money = (value: number) => formatPHP(fromDb(value))

  const costLines: { key: keyof NonNullable<typeof p>['costs']; label: string }[] = [
    { key: 'cogs', label: t('analytics.costCogs') },
    { key: 'shipping', label: t('analytics.costShipping') },
    { key: 'returns', label: t('analytics.costReturns') },
    { key: 'codFees', label: t('analytics.costCodFees') },
    { key: 'paymentFees', label: t('analytics.costPaymentFees') },
    { key: 'platformFees', label: t('analytics.costPlatformFees') },
    { key: 'ads', label: t('analytics.costAds') },
    { key: 'subscription', label: t('analytics.costSubscription') },
  ]

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-headline text-2xl font-bold tracking-tight">{t('analytics.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
      </header>

      {error !== null && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t(error as 'analytics.errorUnknown')}
        </p>
      )}

      {/* The answer, before anything else on the page. */}
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>{t('analytics.thisMonth')}</CardDescription>
          <CardTitle
            id="profit-answer"
            className={`flex flex-wrap items-center gap-2 text-3xl tabular-nums ${
              made ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
            }`}
          >
            {made ? (
              <TrendingUp className="size-6 shrink-0" aria-hidden="true" />
            ) : (
              <TrendingDown className="size-6 shrink-0" aria-hidden="true" />
            )}
            {p === undefined ? '—' : money(p.profit)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            {p === undefined
              ? t('analytics.loading')
              : made
                ? t('analytics.verdictProfit')
                : t('analytics.verdictLoss')}
          </p>

          {/* How much of it to believe. Shown when it is not all of it — a
              permanent banner is a banner nobody reads. */}
          {p !== undefined && coverage < 1 && (
            <p
              id="coverage-warning"
              className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {t('analytics.coverageWarning', {
                  pct: Math.round(coverage * 100),
                  count: p.coverage.itemsWithoutCost,
                })}
              </span>
            </p>
          )}

          {p !== undefined && p.inFlight > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('analytics.inFlight', { amount: money(p.inFlight) })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* The working. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('analytics.workingTitle')}</CardTitle>
          <CardDescription>{t('analytics.workingSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul id="profit-working" className="flex flex-col divide-y text-sm">
            <li className="flex items-center justify-between py-2 font-medium">
              <span>{t('analytics.revenue')}</span>
              <span className="tabular-nums">{p === undefined ? '—' : money(p.revenue)}</span>
            </li>
            {costLines.map((line) => (
              <li key={line.key} className="flex items-center justify-between py-2">
                <span className="text-muted-foreground">{line.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {p === undefined ? '—' : `− ${money(p.costs[line.key])}`}
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between py-2 text-base font-semibold">
              <span>{t('analytics.profit')}</span>
              <span className={`tabular-nums ${made ? '' : 'text-destructive'}`}>
                {p === undefined ? '—' : money(p.profit)}
              </span>
            </li>
          </ul>
          {p !== undefined && (
            <p className="pt-3 text-xs text-muted-foreground">
              {t('analytics.orderSummary', {
                orders: p.orders,
                units: p.units,
                aov: money(p.aov),
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* The retention number, with the honest half beside it. */}
      {commission.data !== undefined && (
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('analytics.commissionKept')}</CardDescription>
            <CardTitle id="commission-kept" className="text-2xl tabular-nums">
              {money(commission.data.kept)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('analytics.commissionKeptHint', {
                pct: (commission.data.bps / 100).toFixed(1),
              })}
            </p>
            {commission.data.paidToMarketplaces > 0 && (
              <p className="pt-1 text-sm text-muted-foreground">
                {t('analytics.commissionPaid', {
                  amount: money(commission.data.paidToMarketplaces),
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Products, ranked by what they earn rather than by what they sell. */}
      {(breakdown.data?.byProduct.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('analytics.productsTitle')}</CardTitle>
            <CardDescription>{t('analytics.productsSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul id="by-product" className="flex flex-col divide-y">
              {(breakdown.data?.byProduct ?? []).map((row) => (
                <li key={row.productName} className="flex flex-wrap items-center gap-2 py-3">
                  <span className="font-medium">{row.productName}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('analytics.unitsSold', { count: row.units })}
                  </span>
                  <span className="ml-auto text-right">
                    <span className="block tabular-nums font-medium">{money(row.margin)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('analytics.marginOf', {
                        pct: row.marginPct,
                        revenue: money(row.revenue),
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {breakdown.data?.worstProduct != null && (
              <p className="pt-3 text-sm text-muted-foreground">
                {t('analytics.worstProduct', {
                  name: breakdown.data.worstProduct.productName,
                  pct: breakdown.data.worstProduct.marginPct,
                })}
              </p>
            )}
            {(breakdown.data?.uncosted.length ?? 0) > 0 && (
              <p id="uncosted-products" className="pt-2 text-sm text-amber-700 dark:text-amber-400">
                {t('analytics.uncostedProducts', {
                  count: breakdown.data?.uncosted.length ?? 0,
                  names: (breakdown.data?.uncosted ?? [])
                    .slice(0, 3)
                    .map((u) => u.productName)
                    .join(', '),
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Where it came from. */}
      {(breakdown.data?.byChannel.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('analytics.whereTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul id="by-channel" className="flex flex-col divide-y text-sm">
              {(breakdown.data?.byChannel ?? []).map((row) => (
                <li key={row.channel} className="flex items-center justify-between py-2">
                  <span>
                    {t(`analytics.channel_${row.channel}` as 'analytics.channel_storefront')}
                  </span>
                  <span className="tabular-nums">
                    {money(row.revenue)}{' '}
                    <span className="text-xs text-muted-foreground">
                      {t('analytics.ordersCount', { count: row.orders })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <ul id="by-city" className="flex flex-col divide-y text-sm">
              {(breakdown.data?.byCity ?? []).slice(0, 5).map((row) => (
                <li key={row.city} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground">{row.city}</span>
                  <span className="tabular-nums text-muted-foreground">{money(row.revenue)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* The trend, which is the only honest way to read an RTS rate. */}
      {(trends.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('analytics.trendTitle')}</CardTitle>
            <CardDescription>{t('analytics.trendSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul id="trend" className="flex flex-col divide-y text-sm">
              {(trends.data ?? []).map((row) => (
                <li key={row.month} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="w-20 shrink-0 text-muted-foreground">
                    {new Date(`${row.month}T00:00:00+08:00`).toLocaleDateString('en-PH', {
                      month: 'short',
                      year: '2-digit',
                      timeZone: 'Asia/Manila',
                    })}
                  </span>
                  <span className="tabular-nums">{money(row.revenue)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {row.rtsRate === null
                      ? t('analytics.rtsUnknown')
                      : t('analytics.rtsRate', { pct: row.rtsRate, count: row.rtsOrders })}
                    {row.cohortRepeatRate === null
                      ? ''
                      : ` · ${t('analytics.repeatRate', { pct: row.cohortRepeatRate })}`}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* The one cost nothing here can observe. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" aria-hidden="true" />
            {t('analytics.adsTitle')}
          </CardTitle>
          <CardDescription>{t('analytics.adsSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(adSpend.data?.length ?? 0) > 0 && (
            <ul className="flex flex-col divide-y text-sm">
              {(adSpend.data ?? []).map((row) => (
                <li key={row.id} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground">
                    {row.spentOn} · {row.channel}
                  </span>
                  <span className="tabular-nums">{money(row.amount)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-date">{t('analytics.adDate')}</Label>
            <Input
              id="ad-date"
              type="date"
              value={spendDate}
              onChange={(event) => setSpendDate(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-channel">{t('analytics.adChannel')}</Label>
            <select
              id="ad-channel"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={spendChannel}
              onChange={(event) => setSpendChannel(event.target.value)}
            >
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="google">Google</option>
              <option value="other">{t('analytics.adOther')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-amount">{t('analytics.adAmount')}</Label>
            <Input
              id="ad-amount"
              inputMode="numeric"
              value={spendPesos}
              onChange={(event) => setSpendPesos(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={spendPesos === '' || addSpend.isPending}
            onClick={() => addSpend.mutate()}
          >
            {t('analytics.adSave')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
