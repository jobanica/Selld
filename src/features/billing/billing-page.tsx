import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, CreditCard, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

import {
  CREDIT_PACKS,
  buyCredits,
  cancelSubscription,
  changePlan,
  describeBillingError,
  fetchPlans,
  fetchSubscription,
  resumeSubscription,
  type Plan,
  type SubscriptionOverview,
} from './billing-api'

/**
 * Invoice status -> translation key, as a literal map rather than a template
 * literal: `t(`billing.invoiceStatus.${status}`)` compiles and loses the check
 * that the string exists, which is how a new status renders as a raw code.
 */
const INVOICE_STATUS_KEYS = {
  open: 'billing.invoiceStatus.open',
  paid: 'billing.invoiceStatus.paid',
  failed: 'billing.invoiceStatus.failed',
  void: 'billing.invoiceStatus.void',
} as const

/**
 * The billing screen.
 *
 * Two things lead, and neither of them is the price:
 *
 *   **what state the account is in**, in a sentence, because "past_due" on its own
 *   tells a seller nothing about whether their store still works — and the answer
 *   ("it does, until the 4th") is the only part they actually need;
 *
 *   **usage against the limits**, because the alternative is finding out at the
 *   moment they press "add product". A bar that is nearly full is a decision the
 *   seller can make on a quiet afternoon; a rejected form is one they have to make
 *   in the middle of doing something else.
 *
 * Mobile-first like everything else: one column at 390px, 44px touch targets, and
 * the plan cards stack rather than scrolling sideways.
 */
export function BillingPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const subscription = useQuery({
    queryKey: ['billing', tenant.id],
    queryFn: () => fetchSubscription(tenant.id),
  })
  const plans = useQuery({
    queryKey: ['billing-plans', tenant.id],
    queryFn: () => fetchPlans(tenant.id),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['billing', tenant.id] })

  const change = useMutation({
    mutationFn: (planId: string) => changePlan({ tenantId: tenant.id, planId }),
    onSuccess: async () => {
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeBillingError(cause)),
  })

  const cancel = useMutation({
    mutationFn: () => cancelSubscription(tenant.id),
    onSuccess: invalidate,
    onError: (cause) => setError(describeBillingError(cause)),
  })

  const resume = useMutation({
    mutationFn: () => resumeSubscription(tenant.id),
    onSuccess: invalidate,
    onError: (cause) => setError(describeBillingError(cause)),
  })

  const credits = useMutation({
    mutationFn: (packSize: number) => buyCredits({ tenantId: tenant.id, credits: packSize }),
    onSuccess: (url) => {
      setError(null)
      window.location.href = url
    },
    onError: (cause) => setError(describeBillingError(cause)),
  })

  const data = subscription.data ?? null

  if (subscription.isLoading) {
    return <p className="p-1 text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (data === null) {
    return <p className="p-1 text-sm text-muted-foreground">{t('billing.noSubscription')}</p>
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('billing.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {data.billedBy === null
            ? t('billing.subtitle')
            : t('billing.subtitleReseller', { name: data.billedBy.name })}
        </p>
      </header>

      {error !== null ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t(error as 'billing.errorUnknown')}
        </p>
      ) : null}

      <StatusCard data={data} />

      <UsageCard data={data} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('billing.plansTitle')}</CardTitle>
          <CardDescription>{t('billing.plansHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {(plans.data ?? []).map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              current={plan.id === data.plan.id}
              busy={change.isPending}
              onChoose={() => change.mutate(plan.id)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="size-4" aria-hidden="true" />
            {t('billing.creditsTitle')}
          </CardTitle>
          <CardDescription>
            {t('billing.creditsBalance', { count: data.smsCredits })}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          {CREDIT_PACKS.map((pack) => (
            <Button
              key={pack}
              variant="outline"
              className="h-11 justify-between"
              disabled={credits.isPending}
              onClick={() => credits.mutate(pack)}
            >
              <span>{t('billing.creditPack', { count: pack })}</span>
              <span className="font-medium">
                {formatPHP(fromDb(pack === 500 ? 25000 : pack === 2000 ? 90000 : 400000))}
              </span>
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('billing.invoicesTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('billing.invoicesEmpty')}</p>
          ) : (
            data.invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium">{formatPHP(fromDb(invoice.amountCentavos))}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatManilaDate(invoice.periodStart)} – {formatManilaDate(invoice.periodEnd)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t(INVOICE_STATUS_KEYS[invoice.status])}
                  </span>
                  {invoice.status === 'open' && invoice.checkoutUrl !== null ? (
                    <Button asChild size="sm" className="h-11">
                      <a href={invoice.checkoutUrl}>{t('billing.pay')}</a>
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="pb-2">
        {data.cancelAt === null ? (
          <Button
            variant="ghost"
            className="h-11 text-muted-foreground"
            disabled={cancel.isPending || data.status === 'cancelled'}
            onClick={() => cancel.mutate()}
          >
            {t('billing.cancel')}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="h-11"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            {t('billing.resume')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The state of the account, as a sentence.
 *
 * `past_due` and `restricted` are the two that matter and they say opposite
 * things about whether the seller can keep working, so they are never rendered as
 * a bare status word. In both cases the storefront is explicitly named as still
 * running: a seller whose card bounced needs to know their customers are not
 * seeing a dead shop, and that is not something they will assume.
 */
function StatusCard({ data }: { data: SubscriptionOverview }) {
  const { t } = useTranslation()

  const tone =
    data.status === 'restricted'
      ? 'border-destructive/40 bg-destructive/5'
      : data.status === 'past_due'
        ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-border'

  const detail =
    data.status === 'trialing' && data.trialEndsAt !== null
      ? t('billing.stateTrialing', { date: formatManilaDate(data.trialEndsAt) })
      : data.status === 'past_due'
        ? t('billing.statePastDue', {
            date: data.graceEndsAt === null ? '' : formatManilaDate(data.graceEndsAt),
          })
        : data.status === 'restricted'
          ? t('billing.stateRestricted')
          : data.status === 'cancelled'
            ? t('billing.stateCancelled')
            : data.cancelAt !== null
              ? t('billing.stateCancelling', { date: formatManilaDate(data.cancelAt) })
              : t('billing.stateActive', { date: formatManilaDate(data.currentPeriodEnd) })

  return (
    <Card className={tone}>
      <CardHeader className="pb-3">
        <CardDescription>{data.plan.name}</CardDescription>
        <CardTitle className="text-2xl">
          {formatPHP(fromDb(data.priceCentavos))}
          <span className="ml-1 text-sm font-normal text-muted-foreground">
            {t('billing.perMonth')}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm">{detail}</p>
      </CardContent>
    </Card>
  )
}

/** Usage against each ceiling, so the edge is visible before it is hit. */
function UsageCard({ data }: { data: SubscriptionOverview }) {
  const { t } = useTranslation()
  // `as const` so the key survives as a literal type — a `Record<string, ...>`
  // compiles and silently loses key checking, per CLAUDE.md.
  const rows = [
    {
      labelKey: 'billing.usageProducts',
      used: data.usage.products,
      limit: data.plan.limits.maxProducts,
    },
    {
      labelKey: 'billing.usageUsers',
      used: data.usage.users,
      limit: data.plan.limits.maxUsers,
    },
    {
      labelKey: 'billing.usageOrders',
      used: data.usage.ordersThisMonth,
      limit: data.plan.limits.maxOrdersPerMonth,
    },
  ] as const

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('billing.usageTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const pct = row.limit === null ? 0 : Math.min(100, Math.round((row.used / Math.max(row.limit, 1)) * 100))
          return (
            <div key={row.labelKey} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <span>{t(row.labelKey)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {row.limit === null
                    ? t('billing.usageUnlimited', { used: row.used })
                    : `${String(row.used)} / ${String(row.limit)}`}
                </span>
              </div>
              {row.limit === null ? null : (
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
                    style={{ width: `${String(pct)}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

/**
 * Feature slug -> translation key, as a literal map.
 *
 * A template-literal key compiles and loses the compile-time check that the
 * string exists, which is how a plan gains a feature and the screen renders its
 * raw slug in both locales. A new feature has to be added here, which is the
 * point.
 */
const FEATURE_KEYS = {
  live: 'billing.feature.live',
  broadcasts: 'billing.feature.broadcasts',
  marketplaces: 'billing.feature.marketplaces',
  white_label: 'billing.feature.white_label',
} as const satisfies Record<string, `billing.feature.${string}`>

function PlanCard({
  plan,
  current,
  busy,
  onChoose,
}: {
  plan: Plan
  current: boolean
  busy: boolean
  onChoose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={current ? 'rounded-lg border-2 border-primary p-4' : 'rounded-lg border p-4'}>
      <div className="flex items-baseline justify-between">
        <p className="font-medium">{plan.name}</p>
        <p className="text-sm tabular-nums">{formatPHP(fromDb(plan.priceCentavos))}</p>
      </div>
      {plan.description === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p>
      )}
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        <li>
          {plan.limits.maxProducts === null
            ? t('billing.limitProductsUnlimited')
            : t('billing.limitProductsCount', { count: plan.limits.maxProducts })}
        </li>
        <li>
          {plan.limits.maxUsers === null
            ? t('billing.limitUsersUnlimited')
            : t('billing.limitUsersCount', { count: plan.limits.maxUsers })}
        </li>
        {plan.limits.features.map((feature) => (
          <li key={feature} className="flex items-center gap-1">
            <Check className="size-3" aria-hidden="true" />
            {t(FEATURE_KEYS[feature as keyof typeof FEATURE_KEYS] ?? 'billing.feature.live', {
              defaultValue: feature,
            })}
          </li>
        ))}
      </ul>
      <Button
        className="mt-4 h-11 w-full"
        variant={current ? 'secondary' : 'default'}
        disabled={current || busy}
        onClick={onChoose}
      >
        <CreditCard className="mr-2 size-4" aria-hidden="true" />
        {current ? t('billing.currentPlan') : t('billing.choosePlan')}
      </Button>
    </div>
  )
}
