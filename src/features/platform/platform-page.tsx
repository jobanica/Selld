import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Building2, Megaphone, Search, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'

import { statusKey } from './status-keys'
import {
  announce,
  createReseller,
  describePlatformError,
  fetchImpersonationLog,
  fetchPlatformOverview,
  fetchPlatformRoles,
  fetchPlatformTenants,
} from './platform-api'

/**
 * Selld's own console.
 *
 * Three things, in the order somebody at Selld actually needs them: **is the
 * business healthy**, **which store is this person emailing about**, and **who has
 * been inside a seller's account**.
 *
 * The impersonation log is on this screen rather than buried in a settings tab
 * because it is the thing that keeps everyone honest, and a log nobody looks at is
 * a log nobody minds appearing in. It is the same rows the seller sees on their own
 * store, which is the point.
 */
export function PlatformPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const [resellerName, setResellerName] = useState('')
  const [resellerSlug, setResellerSlug] = useState('')
  const [resellerEmail, setResellerEmail] = useState('')
  const [commissionPct, setCommissionPct] = useState('20')

  const roles = useQuery({ queryKey: ['platform-roles'], queryFn: () => fetchPlatformRoles() })
  const isAdmin = roles.data?.isPlatformAdmin === true

  const overview = useQuery({
    queryKey: ['platform-overview'],
    queryFn: () => fetchPlatformOverview(),
    enabled: isAdmin,
  })
  const tenants = useQuery({
    queryKey: ['platform-tenants', search],
    queryFn: () => fetchPlatformTenants(search),
    enabled: isAdmin,
  })
  const log = useQuery({
    queryKey: ['platform-log'],
    queryFn: () => fetchImpersonationLog(),
    enabled: isAdmin,
  })

  const post = useMutation({
    mutationFn: () => announce({ title, body }),
    onSuccess: () => {
      setTitle('')
      setBody('')
      setError(null)
    },
    onError: (cause) => setError(describePlatformError(cause)),
  })

  const addReseller = useMutation({
    mutationFn: () =>
      createReseller({
        name: resellerName,
        slug: resellerSlug,
        ownerEmail: resellerEmail,
        // Percent in, basis points out, once, here — never a float in the middle.
        commissionBps: Math.round(Number(commissionPct) * 100),
      }),
    onSuccess: async () => {
      setResellerName('')
      setResellerSlug('')
      setResellerEmail('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['platform-overview'] })
    },
    onError: (cause) => setError(describePlatformError(cause)),
  })

  if (roles.isLoading) {
    return <p className="p-1 text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (!isAdmin) {
    return <p className="p-1 text-sm text-muted-foreground">{t('platform.notAllowed')}</p>
  }

  const stats = overview.data

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldCheck className="size-5" aria-hidden="true" />
          {t('platform.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('platform.subtitle')}</p>
      </header>

      {error !== null ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t(error as 'platform.errorUnknown')}
        </p>
      ) : null}

      {stats === undefined ? null : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t('platform.mrr')} value={formatPHP(fromDb(stats.mrrCentavos))} />
          <Stat label={t('platform.activeStores')} value={String(stats.stores.active)} />
          <Stat
            label={t('platform.churn')}
            value={
              stats.churn.rate === null
                ? '—'
                : t('platform.churnValue', { rate: stats.churn.rate, base: stats.churn.base })
            }
          />
          <Stat
            label={t('platform.overdue')}
            value={formatPHP(fromDb(stats.overdueCentavos))}
            tone={stats.overdueCentavos > 0 ? 'warn' : undefined}
          />
        </div>
      )}

      {stats === undefined ? null : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('platform.pipeline')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Mini label={t('platform.trialing')} value={stats.stores.trialing} />
            <Mini label={t('platform.pastDue')} value={stats.stores.pastDue} />
            <Mini label={t('platform.restricted')} value={stats.stores.restricted} />
            <Mini label={t('platform.cancelled')} value={stats.stores.cancelled} />
            <Mini label={t('platform.new30d')} value={stats.stores.new30d} />
            <Mini label={t('platform.resellerStores')} value={stats.resellerStores} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('platform.storesTitle')}</CardTitle>
          <CardDescription>{t('platform.storesHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <Input
              className="h-11"
              value={search}
              placeholder={t('platform.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            {(tenants.data ?? []).map((store) => (
              <div key={store.tenantId} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{store.name}</p>
                  <p className="text-xs text-muted-foreground">{store.slug}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {store.planName ?? '—'} · {t(statusKey(store.status))} ·{' '}
                  {store.priceCentavos === null ? '—' : formatPHP(fromDb(store.priceCentavos))}
                  {store.reseller === null ? '' : ` · ${store.reseller}`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('platform.storeUsage', {
                    orders: store.orders,
                    products: store.products,
                    users: store.users,
                  })}
                </p>
              </div>
            ))}
            {(tenants.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('platform.storesEmpty')}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" aria-hidden="true" />
            {t('platform.newReseller')}
          </CardTitle>
          <CardDescription>{t('platform.newResellerHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="reseller-name">{t('platform.resellerName')}</Label>
            <Input
              id="reseller-name"
              className="h-11"
              value={resellerName}
              onChange={(event) => setResellerName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reseller-slug">{t('platform.resellerSlug')}</Label>
            <Input
              id="reseller-slug"
              className="h-11"
              value={resellerSlug}
              onChange={(event) => setResellerSlug(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reseller-email">{t('platform.resellerEmail')}</Label>
            <Input
              id="reseller-email"
              type="email"
              className="h-11"
              value={resellerEmail}
              onChange={(event) => setResellerEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reseller-commission">{t('platform.commission')}</Label>
            <Input
              id="reseller-commission"
              inputMode="decimal"
              className="h-11"
              value={commissionPct}
              onChange={(event) => setCommissionPct(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button
              className="h-11 w-full sm:w-auto"
              disabled={addReseller.isPending || resellerName === '' || resellerSlug === ''}
              onClick={() => addReseller.mutate()}
            >
              {t('platform.createReseller')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" aria-hidden="true" />
            {t('platform.announceTitle')}
          </CardTitle>
          <CardDescription>{t('platform.announceHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="announce-title">{t('platform.announceHeadline')}</Label>
            <Input
              id="announce-title"
              className="h-11"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="announce-body">{t('platform.announceBody')}</Label>
            <Input
              id="announce-body"
              className="h-11"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <Button
            className="h-11"
            disabled={post.isPending || title.trim() === '' || body.trim() === ''}
            onClick={() => post.mutate()}
          >
            {t('platform.announceSend')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('platform.logTitle')}</CardTitle>
          <CardDescription>{t('platform.logHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(log.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('platform.logEmpty')}</p>
          ) : (
            (log.data ?? []).map((row) => (
              <div key={row.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{row.tenantName}</p>
                <p className="text-xs text-muted-foreground">
                  {row.actorEmail ?? '—'} · {formatManilaDateTime(row.startedAt)} ·{' '}
                  {t(
                    row.actorKind === 'platform'
                      ? 'platform.actorKind.platform'
                      : 'platform.actorKind.reseller',
                  )}
                </p>
                <p className="mt-1 text-xs">{row.reason}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn' | undefined
}) {
  return (
    <Card className={tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5' : undefined}>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-medium tabular-nums">{value}</p>
    </div>
  )
}
