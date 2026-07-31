import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import type { StatementCourier } from '@/core/cod/statement'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

import {
  describeCodError,
  discardBatch,
  fetchBatchLines,
  fetchReconciliation,
  importStatement,
  postBatch,
  type ImportSummary,
  type MatchStatus,
} from './cod-api'

const COURIERS: { id: StatementCourier; label: string }[] = [
  { id: 'jnt', label: 'J&T Express' },
  { id: 'flash', label: 'Flash Express' },
  { id: 'lbc', label: 'LBC' },
  { id: 'ninja', label: 'Ninja Van' },
  { id: 'other', label: 'Other' },
]

/**
 * Import a courier statement, look at what it says, then decide.
 *
 * The two steps are separate on purpose. Importing produces a **draft**: the file
 * is matched against the seller's own parcels and the result is shown, but nothing
 * is marked paid. Posting is a second, explicit click.
 *
 * That costs a tap and buys the ability to undo. An import that posted immediately
 * would turn "I picked the wrong courier in the dropdown" into a set of false paid
 * flags spread across the order book, and there is no screen in this product that
 * un-does that in bulk.
 */
export function StatementImport() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [courier, setCourier] = useState<StatementCourier>('jnt')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    summary: ImportSummary
    columns: Record<string, string | null>
    skipped: number
  } | null>(null)

  const recon = useQuery({
    queryKey: ['cod-reconciliation', tenant.id],
    queryFn: () => fetchReconciliation(tenant.id),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['cod-reconciliation', tenant.id] })

  const draftId = result?.summary.status === 'draft' ? result.summary.id : null

  const lines = useQuery({
    queryKey: ['cod-lines', draftId],
    queryFn: () => fetchBatchLines(draftId!, true),
    enabled: draftId !== null,
  })

  const upload = useMutation({
    mutationFn: (file: File) => importStatement(tenant.id, courier, file),
    onSuccess: async (data) => {
      setError(null)
      setResult(data)
      await invalidate()
    },
    onError: (cause) => {
      setResult(null)
      setError(describeCodError(cause))
    },
  })

  const post = useMutation({
    mutationFn: (id: string) => postBatch(id),
    onSuccess: async () => {
      setResult(null)
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeCodError(cause)),
  })

  const discard = useMutation({
    mutationFn: (id: string) => discardBatch(id),
    onSuccess: async () => {
      setResult(null)
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeCodError(cause)),
  })

  const byStatus = result?.summary.byStatus ?? {}
  const postable = (byStatus.matched?.count ?? 0) + (byStatus.variance?.count ?? 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="size-4" aria-hidden="true" />
          {t('cod.importTitle')}
        </CardTitle>
        <CardDescription>{t('cod.importSubtitle')}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="cod-courier">{t('cod.courierLabel')}</Label>
          <div className="flex flex-wrap gap-2">
            {COURIERS.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant={courier === option.id ? 'default' : 'outline'}
                // 44px minimum touch target: sellers do this from a phone.
                className="h-11"
                onClick={() => setCourier(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <input
            ref={fileInput}
            id="cod-file"
            type="file"
            className="sr-only"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) upload.mutate(file)
              // Cleared so re-picking the same file after a failure fires `change`
              // again — otherwise a seller's second attempt does nothing at all.
              event.target.value = ''
            }}
          />
          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="mr-2 size-4" aria-hidden="true" />
            {upload.isPending ? t('cod.reading') : t('cod.chooseFile')}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('cod.fileHint')}</p>
        </div>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'cod.errorUnknown')}
          </p>
        )}

        {result !== null && (
          <div className="flex flex-col gap-3 rounded-lg border p-4" role="status">
            {/* How the file was read, before what it means. A seller whose columns
                were mis-detected needs to see that, not a wall of red. */}
            <p className="text-xs text-muted-foreground">
              {t('cod.readAs', {
                waybill: result.columns.waybill ?? '—',
                amount: result.columns.amount ?? '—',
              })}
            </p>

            <p className="text-sm font-medium">
              {t('cod.importedCount', { count: result.summary.lineCount })}{' '}
              <span className="tabular">{formatPHP(fromDb(result.summary.lineTotal))}</span>
            </p>

            {result.summary.declaredTotal !== null &&
              result.summary.declaredTotal !== result.summary.lineTotal && (
                <p className="text-sm text-warning">
                  {t('cod.declaredMismatch', {
                    declared: formatPHP(fromDb(result.summary.declaredTotal)),
                    lines: formatPHP(fromDb(result.summary.lineTotal)),
                  })}
                </p>
              )}

            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {(
                ['matched', 'variance', 'unknown_waybill', 'duplicate', 'not_cod'] as MatchStatus[]
              ).map((status) =>
                byStatus[status] === undefined ? null : (
                  <li key={status} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{t(MATCH_LABELS[status])}</span>
                    <span className="font-medium tabular">{byStatus[status]!.count}</span>
                  </li>
                ),
              )}
            </ul>

            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('cod.skippedRows', { count: result.skipped })}
              </p>
            )}

            {(lines.data ?? []).length > 0 && (
              <ul className="flex max-h-64 flex-col divide-y overflow-y-auto text-sm">
                {(lines.data ?? []).map((line) => (
                  <li key={line.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                    <span className="font-medium tabular">{line.orderNumber ?? line.waybill}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(MATCH_LABELS[line.matchStatus])}
                    </span>
                    <span className="ml-auto shrink-0 tabular">
                      {formatPHP(fromDb(line.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {result.summary.status === 'draft' && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11"
                  disabled={post.isPending || postable === 0}
                  onClick={() => post.mutate(result.summary.id)}
                >
                  {t('cod.postAction', { count: postable })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={discard.isPending}
                  onClick={() => discard.mutate(result.summary.id)}
                >
                  {t('cod.discardAction')}
                </Button>
              </div>
            )}
          </div>
        )}

        {(recon.data?.batches ?? []).length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('cod.historyTitle')}</h3>
            <ul className="flex flex-col divide-y text-sm">
              {(recon.data?.batches ?? []).map((batch) => (
                <li key={batch.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                  <span className="font-medium uppercase">{batch.courier}</span>
                  <span className="text-xs text-muted-foreground">
                    {batch.filename ?? batch.reference ?? formatManilaDate(batch.createdAt)}
                  </span>
                  <span className="ml-auto shrink-0 tabular">
                    {formatPHP(fromDb(batch.amount))}
                  </span>
                  <span className="w-full text-xs text-muted-foreground sm:w-auto">
                    {batch.status === 'posted'
                      ? t('cod.batchPosted', { count: batch.lineCount })
                      : t('cod.batchDraft', { count: batch.lineCount })}
                    {batch.problemCount > 0 && ` · ${t('cod.batchProblems', { count: batch.problemCount })}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  )
}

/** Literal keys, spelled out — a template literal would type-check as `string`. */
const MATCH_LABELS = {
  matched: 'cod.matchMatched',
  variance: 'cod.matchVariance',
  unknown_waybill: 'cod.matchUnknown',
  duplicate: 'cod.matchDuplicate',
  not_cod: 'cod.matchNotCod',
} as const
