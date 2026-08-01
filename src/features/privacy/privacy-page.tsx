import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, ShieldAlert, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatManilaDate, formatManilaDateTime } from '@/lib/time/manila'

import {
  closeRequest,
  describePrivacyError,
  exportSubject,
  fetchBreaches,
  fetchRequests,
  markNotified,
  openRequest,
  recordBreach,
  serveDeletion,
  type DsrKind,
} from './privacy-api'

/**
 * The seller's privacy desk.
 *
 * Two queues, and both are built around a deadline rather than around a status,
 * because the failure this screen exists to prevent is not "we handled it badly"
 * — it is "we did not notice in time". A buyer's request is fifteen days; a
 * breach is seventy-two hours from the moment you found out. So the date is
 * beside every row and an overdue one is red, and neither queue sorts by when it
 * arrived.
 *
 * The deletion button says what it will actually do before it does it, in the
 * seller's own terms: the person goes, the sales records stay. A seller who
 * believes "delete" means "delete the orders" will refuse the request out of fear
 * of BIR, which is the worst of all outcomes for everybody.
 */
export function PrivacyPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const [kind, setKind] = useState<DsrKind>('export')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')

  const [nature, setNature] = useState('')
  const [description, setDescription] = useState('')
  const [discovered, setDiscovered] = useState(() => new Date().toISOString().slice(0, 16))
  const [affected, setAffected] = useState('')

  const requests = useQuery({
    queryKey: ['dsr', tenant.id],
    queryFn: () => fetchRequests(tenant.id),
  })
  const breaches = useQuery({
    queryKey: ['breaches', tenant.id],
    queryFn: () => fetchBreaches(tenant.id),
  })

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dsr', tenant.id] }),
      queryClient.invalidateQueries({ queryKey: ['breaches', tenant.id] }),
    ])

  const log = useMutation({
    mutationFn: () => openRequest({ tenantId: tenant.id, kind, phone, note }),
    onSuccess: async () => {
      setPhone('')
      setNote('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describePrivacyError(cause)),
  })

  const download = useMutation({
    mutationFn: (subjectPhone: string) => exportSubject(tenant.id, subjectPhone),
    onSuccess: (data, subjectPhone) => {
      setError(null)
      // A blob in the browser, not an email. This is the most concentrated piece
      // of personal data the product can produce, and mailing it leaves a copy on
      // a server nobody here controls.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `selld-data-${subjectPhone.replace(/[^0-9]/g, '')}.json`
      link.click()
      URL.revokeObjectURL(url)
    },
    onError: (cause) => setError(describePrivacyError(cause)),
  })

  const erase = useMutation({
    mutationFn: (requestId: string) => serveDeletion(requestId),
    onSuccess: async () => {
      setConfirming(null)
      setError(null)
      await invalidate()
    },
    onError: (cause) => {
      setConfirming(null)
      setError(describePrivacyError(cause))
    },
  })

  const dismiss = useMutation({
    mutationFn: (requestId: string) =>
      closeRequest({ requestId, status: 'refused', reason: 'closed by the seller' }),
    onSuccess: invalidate,
    onError: (cause) => setError(describePrivacyError(cause)),
  })

  const logBreach = useMutation({
    mutationFn: () =>
      recordBreach({
        tenantId: tenant.id,
        nature,
        description,
        discoveredAt: new Date(discovered).toISOString(),
        ...(affected.trim() === '' ? {} : { affectedCount: Number(affected) }),
      }),
    onSuccess: async () => {
      setNature('')
      setDescription('')
      setAffected('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describePrivacyError(cause)),
  })

  const notified = useMutation({
    mutationFn: (id: string) => markNotified(id),
    onSuccess: invalidate,
    onError: (cause) => setError(describePrivacyError(cause)),
  })

  const statusLabel = (status: string): string =>
    status === 'open'
      ? t('privacy.statusOpen')
      : status === 'served'
        ? t('privacy.statusServed')
        : status === 'refused'
          ? t('privacy.statusRefused')
          : t('privacy.statusWithdrawn')

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('privacy.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('privacy.subtitle')}</p>
      </header>

      {error !== null ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t(error as 'privacy.errorUnknown')}
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('privacy.requestsTitle')}</CardTitle>
          <CardDescription>{t('privacy.requestsHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(requests.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('privacy.requestsEmpty')}</p>
          ) : (
            (requests.data ?? []).map((row) => (
              <div
                key={row.id}
                data-testid="dsr-row"
                className={
                  row.overdue
                    ? 'rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm'
                    : 'rounded-md border p-3 text-sm'
                }
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {row.kind === 'export'
                      ? t('privacy.kindExport')
                      : row.kind === 'deletion'
                        ? t('privacy.kindDeletion')
                        : t('privacy.kindCorrection')}
                  </p>
                  <p className="text-xs text-muted-foreground">{row.phone}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {statusLabel(row.status)} ·{' '}
                  {row.status === 'open'
                    ? row.overdue
                      ? t('privacy.overdue')
                      : t('privacy.due', { date: formatManilaDate(row.dueAt) })
                    : t('privacy.served', {
                        date: row.servedAt === null ? '' : formatManilaDate(row.servedAt),
                      })}
                  {row.outcome?.orders === undefined
                    ? ''
                    : ` · ${t('privacy.deleted', { count: row.outcome.orders })}`}
                </p>

                {row.status === 'open' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11"
                      disabled={download.isPending}
                      onClick={() => download.mutate(row.phone)}
                    >
                      <Download className="mr-1 size-3" aria-hidden="true" />
                      {t('privacy.exportAction')}
                    </Button>

                    {row.kind === 'deletion' ? (
                      confirming === row.id ? (
                        <div className="w-full rounded-md border border-destructive/40 bg-destructive/5 p-3">
                          <p className="text-xs">{t('privacy.deleteConfirm')}</p>
                          <div className="mt-2 flex gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-11"
                              disabled={erase.isPending}
                              onClick={() => erase.mutate(row.id)}
                            >
                              {t('privacy.deleteAction')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-11"
                              onClick={() => setConfirming(null)}
                            >
                              {t('common.cancel')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-11"
                          onClick={() => setConfirming(row.id)}
                        >
                          <Trash2 className="mr-1 size-3" aria-hidden="true" />
                          {t('privacy.deleteAction')}
                        </Button>
                      )
                    ) : null}

                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-11 text-muted-foreground"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(row.id)}
                    >
                      {t('privacy.close')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}

          <div className="grid gap-3 border-t pt-4 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="dsr-kind">{t('privacy.kind')}</Label>
              <select
                id="dsr-kind"
                className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value as DsrKind)}
              >
                <option value="export">{t('privacy.kindExport')}</option>
                <option value="deletion">{t('privacy.kindDeletion')}</option>
                <option value="correction">{t('privacy.kindCorrection')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dsr-phone">{t('privacy.phone')}</Label>
              <Input
                id="dsr-phone"
                className="h-11"
                inputMode="tel"
                placeholder="09171234567"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dsr-note">{t('privacy.note')}</Label>
              <Input
                id="dsr-note"
                className="h-11"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                className="h-11 w-full"
                disabled={log.isPending || phone.trim() === ''}
                onClick={() => log.mutate()}
              >
                {t('privacy.open')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4" aria-hidden="true" />
            {t('privacy.breachTitle')}
          </CardTitle>
          <CardDescription>{t('privacy.breachHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(breaches.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('privacy.breachEmpty')}</p>
          ) : (
            (breaches.data ?? []).map((row) => (
              <div
                key={row.id}
                className={
                  row.overdue
                    ? 'rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm'
                    : 'rounded-md border p-3 text-sm'
                }
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{row.nature}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatManilaDateTime(row.discoveredAt)}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{row.description}</p>
                <p className="mt-1 text-xs">
                  {row.overdue
                    ? t('privacy.overdue')
                    : t('privacy.breachDue', { date: formatManilaDateTime(row.notifyDueAt) })}
                </p>
                {row.status === 'notified' || row.status === 'closed' ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-11"
                    disabled={notified.isPending}
                    onClick={() => notified.mutate(row.id)}
                  >
                    {t('privacy.breachMarkNotified')}
                  </Button>
                )}
              </div>
            ))
          )}

          <div className="grid gap-3 border-t pt-4 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="breach-nature">{t('privacy.breachNature')}</Label>
              <Input
                id="breach-nature"
                className="h-11"
                value={nature}
                onChange={(event) => setNature(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="breach-description">{t('privacy.breachDescription')}</Label>
              <Input
                id="breach-description"
                className="h-11"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="breach-discovered">{t('privacy.breachDiscovered')}</Label>
              <Input
                id="breach-discovered"
                type="datetime-local"
                className="h-11"
                value={discovered}
                onChange={(event) => setDiscovered(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="breach-affected">{t('privacy.breachAffected')}</Label>
              <Input
                id="breach-affected"
                inputMode="numeric"
                className="h-11"
                value={affected}
                onChange={(event) => setAffected(event.target.value)}
              />
            </div>
            <div className="sm:col-span-4">
              <Button
                className="h-11 w-full sm:w-auto"
                disabled={logBreach.isPending || nature.trim() === '' || description.trim() === ''}
                onClick={() => logBreach.mutate()}
              >
                {t('privacy.breachRecord')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
