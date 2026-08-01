import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Copy, Palette, Store, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatPHP, fromDb, parsePesos } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

import { statusKey } from './status-keys'
import {
  createSellerTenant,
  describePlatformError,
  fetchPlatformRoles,
  fetchResellerOverview,
  fetchRevenueSplit,
  setResellerBranding,
  upsertResellerPlan,
  type CreatedSeller,
} from './platform-api'

/**
 * The reseller console — the screen the phase-19 done-when is about.
 *
 * "A reseller can onboard and bill their own seller without you touching
 * anything." So the onboarding form is the first thing on the page, above the
 * numbers: everything else here is reporting, and reporting is what you read
 * *after* the thing you came to do.
 *
 * The invitation link is shown once, right after the store is created, with a copy
 * button — because the reseller is the one who sends it, and a token that appears
 * in a toast that vanishes is a store nobody can claim.
 */
export function ResellerPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedSeller | null>(null)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [email, setEmail] = useState('')
  const [planId, setPlanId] = useState('')
  const [price, setPrice] = useState('')

  const [planCode, setPlanCode] = useState('')
  const [planName, setPlanName] = useState('')
  const [planPrice, setPlanPrice] = useState('')

  const [brandName, setBrandName] = useState('')
  const [brandColor, setBrandColor] = useState('')
  const [supportEmail, setSupportEmail] = useState('')

  const roles = useQuery({ queryKey: ['platform-roles'], queryFn: () => fetchPlatformRoles() })
  const isReseller = roles.data?.reseller != null

  const overview = useQuery({
    queryKey: ['reseller-overview'],
    queryFn: () => fetchResellerOverview(),
    enabled: isReseller,
  })
  const split = useQuery({
    queryKey: ['reseller-split'],
    queryFn: () => fetchRevenueSplit(),
    enabled: isReseller,
  })

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reseller-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['reseller-split'] }),
    ])

  const onboard = useMutation({
    mutationFn: () => {
      const pesos = price.trim() === '' ? null : parsePesos(price)
      return createSellerTenant({
        name,
        slug,
        ownerEmail: email,
        planId,
        ...(pesos === null ? {} : { priceCentavos: pesos }),
      })
    },
    onSuccess: async (result) => {
      setCreated(result)
      setName('')
      setSlug('')
      setEmail('')
      setPrice('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describePlatformError(cause)),
  })

  const savePlan = useMutation({
    mutationFn: () =>
      upsertResellerPlan({
        code: planCode,
        name: planName,
        priceCentavos: parsePesos(planPrice) ?? 0,
        maxProducts: null,
        maxUsers: null,
        features: ['live', 'broadcasts'],
      }),
    onSuccess: async () => {
      setPlanCode('')
      setPlanName('')
      setPlanPrice('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describePlatformError(cause)),
  })

  const saveBrand = useMutation({
    mutationFn: () =>
      setResellerBranding({
        ...(brandName.trim() === '' ? {} : { brandName: brandName.trim() }),
        ...(brandColor.trim() === '' ? {} : { brandColor: brandColor.trim() }),
        ...(supportEmail.trim() === '' ? {} : { supportEmail: supportEmail.trim() }),
      }),
    onSuccess: async () => {
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describePlatformError(cause)),
  })

  if (roles.isLoading) {
    return <p className="p-1 text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (!isReseller) {
    return <p className="p-1 text-sm text-muted-foreground">{t('platform.notReseller')}</p>
  }

  const data = overview.data
  const plans = data?.plans ?? []
  const inviteUrl =
    created === null ? '' : `${window.location.origin}/invite/${created.invitationToken}`

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Store className="size-5" aria-hidden="true" />
          {data?.reseller.brandName ?? data?.reseller.name ?? t('reseller.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('reseller.subtitle')}</p>
      </header>

      {error !== null ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t(error as 'platform.errorUnknown')}
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="size-4" aria-hidden="true" />
            {t('reseller.onboardTitle')}
          </CardTitle>
          <CardDescription>{t('reseller.onboardHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="seller-name">{t('reseller.storeName')}</Label>
            <Input
              id="seller-name"
              className="h-11"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="seller-slug">{t('reseller.storeSlug')}</Label>
            <Input
              id="seller-slug"
              className="h-11"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="seller-email">{t('reseller.ownerEmail')}</Label>
            <Input
              id="seller-email"
              type="email"
              className="h-11"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="seller-plan">{t('reseller.plan')}</Label>
            <select
              id="seller-plan"
              className="h-11 w-full rounded-md border bg-background px-3 text-sm"
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
            >
              <option value="">{t('reseller.planPick')}</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} — {formatPHP(fromDb(plan.priceCentavos))}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="seller-price">{t('reseller.priceOverride')}</Label>
            <Input
              id="seller-price"
              inputMode="decimal"
              className="h-11"
              placeholder={t('reseller.priceOverrideHint')}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="h-11 w-full"
              disabled={onboard.isPending || name === '' || slug === '' || planId === ''}
              onClick={() => onboard.mutate()}
            >
              {t('reseller.onboard')}
            </Button>
          </div>

          {created === null ? null : (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm sm:col-span-2">
              <p className="font-medium">{t('reseller.createdTitle', { name: created.name })}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('reseller.createdHint', { email: created.ownerEmail })}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code
                  data-testid="invite-url"
                  className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs"
                >
                  {inviteUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11"
                  onClick={() => void navigator.clipboard?.writeText(inviteUrl)}
                >
                  <Copy className="mr-1 size-3" aria-hidden="true" />
                  {t('reseller.copyLink')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('reseller.mrr')}</CardDescription>
            <CardTitle className="text-xl tabular-nums">
              {formatPHP(fromDb(data?.mrrCentavos ?? 0))}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('reseller.sellers')}</CardDescription>
            <CardTitle className="text-xl tabular-nums">{data?.sellers.length ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('reseller.keptThisMonth')}</CardDescription>
            <CardTitle className="text-xl tabular-nums" data-testid="reseller-net">
              {formatPHP(fromDb(split.data?.netCentavos ?? 0))}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('reseller.splitTitle')}</CardTitle>
          <CardDescription>{t('reseller.splitHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label={t('reseller.gross')} value={formatPHP(fromDb(split.data?.grossCentavos ?? 0))} />
          <Row
            label={t('reseller.platformCut')}
            value={`− ${formatPHP(fromDb(split.data?.platformCutCentavos ?? 0))}`}
          />
          <div className="border-t pt-2">
            <Row
              label={t('reseller.net')}
              value={formatPHP(fromDb(split.data?.netCentavos ?? 0))}
              strong
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('reseller.sellersTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(data?.sellers ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('reseller.sellersEmpty')}</p>
          ) : (
            (data?.sellers ?? []).map((seller) => (
              <div key={seller.tenantId} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{seller.name}</p>
                  <p className="tabular-nums">
                    {seller.priceCentavos === null
                      ? '—'
                      : formatPHP(fromDb(seller.priceCentavos))}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {seller.planName ?? '—'} · {t(statusKey(seller.status))} ·{' '}
                  {t('reseller.sellerOrders', { count: seller.orders })}
                  {seller.currentPeriodEnd === null
                    ? ''
                    : ` · ${formatManilaDate(seller.currentPeriodEnd)}`}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('reseller.plansTitle')}</CardTitle>
          <CardDescription>{t('reseller.plansHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="plan-code">{t('reseller.planCode')}</Label>
            <Input
              id="plan-code"
              className="h-11"
              value={planCode}
              onChange={(event) => setPlanCode(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-name">{t('reseller.planName')}</Label>
            <Input
              id="plan-name"
              className="h-11"
              value={planName}
              onChange={(event) => setPlanName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-price">{t('reseller.planPrice')}</Label>
            <Input
              id="plan-price"
              inputMode="decimal"
              className="h-11"
              value={planPrice}
              onChange={(event) => setPlanPrice(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="h-11 w-full"
              disabled={savePlan.isPending || planCode === '' || planName === ''}
              onClick={() => savePlan.mutate()}
            >
              {t('reseller.savePlan')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4" aria-hidden="true" />
            {t('reseller.brandTitle')}
          </CardTitle>
          <CardDescription>{t('reseller.brandHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="brand-name">{t('reseller.brandName')}</Label>
            <Input
              id="brand-name"
              className="h-11"
              value={brandName}
              onChange={(event) => setBrandName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="brand-color">{t('reseller.brandColor')}</Label>
            <Input
              id="brand-color"
              className="h-11"
              placeholder="#0F766E"
              value={brandColor}
              onChange={(event) => setBrandColor(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="brand-support">{t('reseller.brandSupport')}</Label>
            <Input
              id="brand-support"
              type="email"
              className="h-11"
              value={supportEmail}
              onChange={(event) => setSupportEmail(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="h-11 w-full"
              disabled={saveBrand.isPending}
              onClick={() => saveBrand.mutate()}
            >
              {t('reseller.saveBrand')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={strong === true ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={strong === true ? 'font-semibold tabular-nums' : 'tabular-nums'}>
        {value}
      </span>
    </div>
  )
}
