import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Send, Ticket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchSegments } from '@/features/customers/customers-api'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'

import {
  describeBroadcastError,
  fetchBroadcasts,
  fetchDiscounts,
  fetchReport,
  previewBroadcast,
  saveBroadcast,
  sendBroadcast,
} from './broadcasts-api'
import { useDebounced } from './use-debounced'
import { VoucherPanel } from './voucher-panel'

/**
 * Broadcasts.
 *
 * The screen is built around one number and one moment: **what will this cost**,
 * and **press send**. Everything else — the segment, the body, the voucher — is
 * an input to that number, and the number is recomputed on every keystroke,
 * because the thing a seller is deciding is not "is this message good" but "is
 * this message worth 790 credits".
 *
 * The split matters as much as the total. "790 by SMS, 5 free on Messenger, 5
 * we cannot reach" is three facts a seller can act on; "800 recipients" is one
 * they cannot.
 */
export function BroadcastsPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [discountId, setDiscountId] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)

  const segments = useQuery({
    queryKey: ['segments', tenant.id],
    queryFn: () => fetchSegments(tenant.id),
  })

  const discounts = useQuery({
    queryKey: ['discounts', tenant.id],
    queryFn: () => fetchDiscounts(tenant.id),
  })

  const broadcasts = useQuery({
    queryKey: ['broadcasts', tenant.id],
    queryFn: () => fetchBroadcasts(tenant.id),
  })

  const definition =
    segments.data?.find((segment) => segment.id === segmentId)?.definition ?? {}

  // Quoted against the body as it settles, not as it is typed — see
  // `useDebounced`. The body that is *sent* is still the live one.
  const quotedBody = useDebounced(body)

  const preview = useQuery({
    queryKey: ['broadcast-preview', tenant.id, segmentId, quotedBody, discountId],
    queryFn: () =>
      previewBroadcast({
        tenantId: tenant.id,
        definition,
        body: quotedBody,
        channel: 'auto',
        discountId: discountId === '' ? null : discountId,
      }),
    enabled: quotedBody.trim() !== '',
  })

  const report = useQuery({
    queryKey: ['broadcast-report', openId],
    queryFn: () => (openId === null ? null : fetchReport(openId)),
    enabled: openId !== null,
  })

  const send = useMutation({
    mutationFn: async () => {
      const id = await saveBroadcast({
        tenantId: tenant.id,
        name: name.trim(),
        body,
        definition,
        channel: 'auto',
        discountId: discountId === '' ? null : discountId,
      })
      setProgress(0)
      await sendBroadcast(id, setProgress)
      return id
    },
    onSuccess: async (id) => {
      setProgress(null)
      setError(null)
      setName('')
      setBody('')
      setOpenId(id)
      await queryClient.invalidateQueries({ queryKey: ['broadcasts', tenant.id] })
    },
    onError: (cause) => {
      setProgress(null)
      setError(describeBroadcastError(cause))
    },
  })

  const cost = preview.data

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-headline text-2xl font-bold tracking-tight">
          {t('broadcasts.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('broadcasts.subtitle')}</p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" aria-hidden="true" />
            {t('broadcasts.composeTitle')}
          </CardTitle>
          <CardDescription>{t('broadcasts.composeSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blast-segment">{t('broadcasts.segmentLabel')}</Label>
            <select
              id="blast-segment"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={segmentId}
              onChange={(event) => setSegmentId(event.target.value)}
            >
              <option value="">{t('broadcasts.segmentEveryone')}</option>
              {(segments.data ?? []).map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name} ({segment.count})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blast-body">{t('broadcasts.bodyLabel')}</Label>
            <textarea
              id="blast-body"
              className="min-h-24 rounded-lg border bg-background p-3 text-sm"
              value={body}
              placeholder={t('broadcasts.bodyPlaceholder')}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('broadcasts.bodyHint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blast-voucher">{t('broadcasts.voucherLabel')}</Label>
            <select
              id="blast-voucher"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={discountId}
              onChange={(event) => setDiscountId(event.target.value)}
            >
              <option value="">{t('broadcasts.voucherNone')}</option>
              {(discounts.data ?? [])
                .filter((discount) => discount.code !== null && discount.is_active)
                .map((discount) => (
                  <option key={discount.id} value={discount.id}>
                    {discount.code} — {discount.name}
                  </option>
                ))}
            </select>
          </div>

          {/* The number the seller is really deciding on. */}
          <div className="rounded-lg bg-muted p-3" id="blast-cost">
            {cost === undefined ? (
              <p className="text-sm text-muted-foreground">{t('broadcasts.costPending')}</p>
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  {t('broadcasts.costCredits', { count: cost.credits })}
                </p>
                <p className="text-sm">
                  {t('broadcasts.costSplit', {
                    sms: cost.sms,
                    messenger: cost.messenger,
                    unreachable: cost.unreachable,
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('broadcasts.costSegments', { count: cost.segments })} ·{' '}
                  {t('broadcasts.costBalance', { balance: cost.balance })}
                </p>
                {!cost.affordable && (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {t('broadcasts.costShort')}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blast-name">{t('broadcasts.nameLabel')}</Label>
            <Input
              id="blast-name"
              value={name}
              placeholder={t('broadcasts.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'broadcasts.errorUnknown')}
            </p>
          )}

          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={
              name.trim() === '' ||
              body.trim() === '' ||
              send.isPending ||
              cost === undefined ||
              !cost.affordable
            }
            onClick={() => send.mutate()}
          >
            <Send className="mr-2 size-4" aria-hidden="true" />
            {progress !== null
              ? t('broadcasts.sending', { count: progress })
              : cost === undefined
                ? // No quote yet, so no number to put on the button. "Send for 0
                  // credits" is not free — it is unpriced, and the two read the
                  // same on a button that happens to be disabled.
                  t('broadcasts.sendIdle')
                : t('broadcasts.sendAction', { count: cost.credits })}
          </Button>
        </CardContent>
      </Card>

      {report.data != null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{report.data.name}</CardTitle>
            <CardDescription>{t('broadcasts.reportSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm">
              {t('broadcasts.reportDelivery', {
                sent: report.data.sent,
                skipped: report.data.skipped,
                credits: report.data.credits,
              })}
            </p>
            <p className="text-sm">
              {t('broadcasts.reportClicks', { count: report.data.clicks })}
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {t('broadcasts.reportRevenue', {
                amount: formatPHP(fromDb(report.data.attributed.revenue)),
                orders: report.data.attributed.orders,
                days: report.data.windowDays,
              })}
            </p>
            {report.data.redeemed.orders > 0 && (
              <p className="text-sm text-muted-foreground">
                {t('broadcasts.reportRedeemed', {
                  orders: report.data.redeemed.orders,
                  amount: formatPHP(fromDb(report.data.redeemed.revenue)),
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {(broadcasts.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('broadcasts.historyTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {(broadcasts.data ?? []).map((blast) => (
                <li key={blast.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-col gap-1 py-3 text-left"
                    onClick={() => setOpenId(blast.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{blast.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                        {blast.status}
                      </span>
                      <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                        {t('broadcasts.historyCredits', { count: blast.credits })}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('broadcasts.historyLine', {
                        sent: blast.sent,
                        clicks: blast.clicks,
                      })}{' '}
                      ·{' '}
                      {formatManilaDateTime(blast.startedAt ?? blast.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <VoucherPanel />
    </div>
  )
}

export { Ticket }
