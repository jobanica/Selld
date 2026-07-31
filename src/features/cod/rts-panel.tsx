import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageX, ShieldBan } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import { setBuyerFlag, type RtsReport } from './cod-api'

/**
 * Returns: what came back, what it cost, and who keeps sending it back.
 *
 * The per-buyer list at the bottom is the part that changes behaviour. A seller
 * looking at "₱4,300 of returns this quarter" shrugs; a seller looking at three
 * phone numbers responsible for a third of it starts asking those buyers to pay up
 * front. That is the entire reason `buyer_risk_flags` exists.
 *
 * Blocking is one tap from that list and nowhere else, because the decision only
 * makes sense next to the evidence for it. The score never blocks anything by
 * itself — a computed rate can be wrong, and refusing someone's money on a signal
 * they cannot see or appeal is not a thing to do automatically.
 */
export function RtsPanel({ report }: { report: RtsReport | undefined }) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const flag = useMutation({
    mutationFn: (input: { phone: string; block: boolean }) =>
      setBuyerFlag(tenant.id, input.phone, input.block),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rts-report', tenant.id] }),
  })

  if (report === undefined) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageX className="size-4" aria-hidden="true" />
          {t('cod.rtsTitle')}
        </CardTitle>
        <CardDescription>
          {t('cod.rtsSubtitle', { days: report.sinceDays })}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label={t('cod.rtsCount')} value={String(report.count)} />
          <Stat label={t('cod.rtsCost')} value={formatPHP(fromDb(report.cost))} />
          <Stat label={t('cod.rtsValue')} value={formatPHP(fromDb(report.valueReturned))} />
        </dl>

        {report.byProvince.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('cod.rtsByProvince')}</h3>
            <ul className="flex flex-col divide-y text-sm">
              {report.byProvince.slice(0, 5).map((row) => (
                <li key={row.province} className="flex items-baseline gap-2 py-2">
                  <span>{row.province}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('cod.parcelCount', { count: row.count })}
                  </span>
                  <span className="ml-auto shrink-0 tabular">{formatPHP(fromDb(row.cost))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {report.repeatOffenders.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('cod.repeatTitle')}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{t('cod.repeatHint')}</p>
            <ul className="flex flex-col divide-y text-sm">
              {report.repeatOffenders.map((buyer) => (
                <li key={buyer.phoneDigits} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                  <span className="font-medium tabular">0{buyer.phoneDigits}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('cod.repeatRow', {
                      rts: buyer.rts,
                      delivered: buyer.delivered,
                      rate: (buyer.rtsRateBps / 100).toFixed(0),
                    })}
                  </span>
                  <Button
                    type="button"
                    variant={buyer.blockCod ? 'default' : 'outline'}
                    className="ml-auto h-11"
                    disabled={flag.isPending}
                    onClick={() =>
                      flag.mutate({ phone: `+63${buyer.phoneDigits}`, block: !buyer.blockCod })
                    }
                  >
                    <ShieldBan className="mr-1.5 size-4" aria-hidden="true" />
                    {buyer.blockCod ? t('cod.codBlocked') : t('cod.blockCod')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular">{value}</dd>
    </div>
  )
}
