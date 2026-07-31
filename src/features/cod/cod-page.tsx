import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Banknote, PackageX, Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import { fetchReconciliation, fetchRtsReport, type CodReconciliation } from './cod-api'
import { RtsPanel } from './rts-panel'
import { StatementImport } from './statement-import'

/**
 * The one screen.
 *
 * The done-when for this phase is a seller answering two questions here and
 * nowhere else: **how much COD is the courier still holding, and which parcels are
 * unaccounted for.** So those two are the top of the page, in that order, before
 * anything about importing files.
 *
 * The headline number is deliberately the *outstanding* balance and not the
 * month's revenue. A seller looking at this screen is about to phone a courier, and
 * what they need in their hand is "you owe me ₱48,320, and ₱12,000 of it is more
 * than thirty days old".
 *
 * Ageing rather than a single total, for the same reason: "₱48,320 outstanding" is
 * a fact, and "₱12,000 of it is over 30 days old" is a phone call. Most PH couriers
 * remit weekly to fortnightly, so anything past thirty days is late rather than
 * pending.
 */
export function CodPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const recon = useQuery({
    queryKey: ['cod-reconciliation', tenant.id],
    queryFn: () => fetchReconciliation(tenant.id),
  })

  const rts = useQuery({
    queryKey: ['rts-report', tenant.id],
    queryFn: () => fetchRtsReport(tenant.id),
  })

  const data = recon.data

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-headline text-2xl font-bold tracking-tight">{t('cod.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('cod.subtitle')}</p>
      </header>

      {/* ---- How much is the courier holding ---------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardDescription className="flex items-center gap-1.5">
            <Banknote className="size-4" aria-hidden="true" />
            {t('cod.outstandingLabel')}
          </CardDescription>
          <CardTitle className="text-3xl tabular sm:text-4xl">
            {formatPHP(fromDb(data?.outstanding.amount ?? 0))}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {t('cod.outstandingParcels', { count: data?.outstanding.count ?? 0 })}
          </p>

          {data !== undefined && data.outstanding.amount > 0 && (
            <AgeingBar buckets={data.outstanding.buckets} total={data.outstanding.amount} />
          )}

          {data !== undefined && data.outstanding.byCourier.length > 0 && (
            <ul className="flex flex-col divide-y text-sm">
              {data.outstanding.byCourier.map((row) => (
                <li key={row.courier} className="flex items-center gap-2 py-2">
                  <span className="font-medium uppercase">{row.courier}</span>
                  <span className="text-muted-foreground">
                    {t('cod.parcelCount', { count: row.count })}
                  </span>
                  <span className="ml-auto shrink-0 tabular">
                    {formatPHP(fromDb(row.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <MiniStat
          icon={<Truck className="size-4" aria-hidden="true" />}
          label={t('cod.inTransitLabel')}
          value={formatPHP(fromDb(data?.inTransit.amount ?? 0))}
          hint={t('cod.parcelCount', { count: data?.inTransit.count ?? 0 })}
        />
        <MiniStat
          icon={<PackageX className="size-4" aria-hidden="true" />}
          label={t('cod.returnedLabel')}
          value={formatPHP(fromDb(data?.returned.amount ?? 0))}
          hint={t('cod.returnedCost', {
            amount: formatPHP(fromDb(data?.returned.cost ?? 0)),
          })}
        />
      </div>

      {/* ---- Which parcels are unaccounted for --------------------------- */}
      <Unaccounted data={data} />

      <StatementImport />

      <RtsPanel report={rts.data} />
    </div>
  )
}

/**
 * Where the money is sitting, by age.
 *
 * A bar rather than four numbers: the shape is the message. A seller whose balance
 * is mostly in the last bucket is owed money that is not coming without a phone
 * call, and that has to be visible without reading.
 */
function AgeingBar({
  buckets,
  total,
}: {
  buckets: CodReconciliation['outstanding']['buckets']
  total: number
}) {
  const { t } = useTranslation()
  const segments = [
    { key: 'd0_7', value: buckets.d0_7, className: 'bg-success' },
    { key: 'd8_14', value: buckets.d8_14, className: 'bg-primary' },
    { key: 'd15_30', value: buckets.d15_30, className: 'bg-warning' },
    { key: 'd31', value: buckets.d31, className: 'bg-destructive' },
  ] as const

  const labels = {
    d0_7: 'cod.age0_7',
    d8_14: 'cod.age8_14',
    d15_30: 'cod.age15_30',
    d31: 'cod.age31',
  } as const

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {segments.map((segment) =>
          segment.value === 0 ? null : (
            <span
              key={segment.key}
              className={segment.className}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ),
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${segment.className}`} aria-hidden="true" />
            <span className="text-muted-foreground">{t(labels[segment.key])}</span>
            <span className="tabular">{formatPHP(fromDb(segment.value))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The second half of the done-when, kept in three separate lists.
 *
 * They look similar and are not: an overdue parcel is a courier who has not paid, an
 * unknown waybill is a payment we cannot place, and a variance is a payment that
 * came up short. A seller does something different about each, so merging them into
 * one "problems" list would hide the action.
 */
function Unaccounted({ data }: { data: CodReconciliation | undefined }) {
  const { t } = useTranslation()
  if (data === undefined) return null

  const { overdue, unknownWaybills, variances } = data.unaccounted
  const total = overdue.length + unknownWaybills.length + variances.length

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
          {t('cod.unaccountedTitle')}
        </CardTitle>
        <CardDescription>{t('cod.unaccountedSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t('cod.unaccountedNone')}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {overdue.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('cod.overdueTitle', { count: overdue.length })}
                </h3>
                <ul className="flex flex-col divide-y text-sm">
                  {overdue.map((parcel) => (
                    <li key={parcel.waybill} className="flex flex-wrap items-baseline gap-x-2 py-2">
                      <span className="font-medium tabular">{parcel.orderNumber}</span>
                      <span className="text-xs uppercase text-muted-foreground">
                        {parcel.courier} {parcel.waybill}
                      </span>
                      <span className="ml-auto shrink-0 tabular">
                        {formatPHP(fromDb(parcel.amount))}
                      </span>
                      <span className="w-full text-xs text-destructive sm:w-auto sm:shrink-0">
                        {t('cod.daysOld', { count: parcel.ageDays })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {unknownWaybills.length > 0 && (
              <section>
                <h3 className="mb-1 text-sm font-semibold">
                  {t('cod.unknownTitle', { count: unknownWaybills.length })}
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">{t('cod.unknownHint')}</p>
                <ul className="flex flex-col divide-y text-sm">
                  {unknownWaybills.map((line) => (
                    <li key={`${line.batchId}-${line.waybill}`} className="flex items-baseline gap-2 py-2">
                      <span className="font-medium tabular">{line.waybill}</span>
                      <span className="text-xs uppercase text-muted-foreground">{line.courier}</span>
                      <span className="ml-auto shrink-0 tabular">
                        {formatPHP(fromDb(line.amount))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {variances.length > 0 && (
              <section>
                <h3 className="mb-1 text-sm font-semibold">
                  {t('cod.varianceTitle', { count: variances.length })}
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">{t('cod.varianceHint')}</p>
                <ul className="flex flex-col divide-y text-sm">
                  {variances.map((line) => (
                    <li key={line.waybill} className="flex flex-wrap items-baseline gap-x-2 py-2">
                      <span className="font-medium tabular">{line.orderNumber ?? line.waybill}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('cod.varianceRow', {
                          expected: formatPHP(fromDb(line.expected ?? 0)),
                          received: formatPHP(fromDb(line.received)),
                        })}
                      </span>
                      <span
                        className={`ml-auto shrink-0 tabular ${
                          line.variance < 0 ? 'text-destructive' : 'text-success'
                        }`}
                      >
                        {line.variance > 0 ? '+' : ''}
                        {formatPHP(fromDb(line.variance))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MiniStat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-xl tabular">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}
