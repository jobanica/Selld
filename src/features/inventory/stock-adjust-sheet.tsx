import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import type { Translate } from '@/lib/i18n'
import { formatManilaDateTime } from '@/lib/time/manila'
import { cn } from '@/lib/utils'

import {
  describeStockError,
  fetchMovements,
  MANUAL_STOCK_REASONS,
  recordMovement,
  setLowStockThreshold,
  setStockLevel,
  type InventoryRow,
  type StockReason,
} from './inventory-api'

/**
 * Stock adjustment, with the movement ledger underneath it.
 *
 * The ledger is not a separate screen on purpose. A seller adjusting stock is
 * almost always reconciling — "it says 7, I counted 5, where did two go" — and the
 * history that answers that question belongs in front of her at the moment she asks
 * it, not one navigation away.
 *
 * Two modes, because sellers think in both: **relative** ("received 50", "2 broke")
 * and **absolute** ("I counted 5"). Absolute still writes the difference as a
 * movement, so the ledger stays complete either way.
 */
export function StockAdjustSheet({
  row,
  onClose,
}: {
  row: InventoryRow
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [mode, setMode] = useState<'relative' | 'absolute'>('relative')
  const [delta, setDelta] = useState('')
  const [absolute, setAbsolute] = useState(String(row.onHand))
  const [reason, setReason] = useState<StockReason>('receive')
  const [note, setNote] = useState('')
  const [threshold, setThreshold] = useState(
    row.lowStockThreshold === null ? '' : String(row.lowStockThreshold),
  )
  const [error, setError] = useState<string | null>(null)

  const movements = useQuery({
    queryKey: ['stock-movements', row.variantId],
    queryFn: () => fetchMovements(row.variantId),
  })

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'relative') {
        const parsed = Number(delta)
        if (!Number.isInteger(parsed) || parsed === 0) {
          throw new DeltaError()
        }
        await recordMovement({
          tenantId: tenant.id,
          variantId: row.variantId,
          locationId: row.locationId,
          delta: parsed,
          reason,
          note: note.trim() || undefined,
        })
      } else {
        const parsed = Number(absolute)
        if (!Number.isInteger(parsed) || parsed < 0) throw new DeltaError()
        await setStockLevel({
          tenantId: tenant.id,
          variantId: row.variantId,
          locationId: row.locationId,
          onHand: parsed,
          note: note.trim() || undefined,
        })
      }

      const nextThreshold = threshold.trim() === '' ? null : Number(threshold)
      if (nextThreshold !== row.lowStockThreshold) {
        await setLowStockThreshold(row.id, nextThreshold)
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['stock-movements', row.variantId] }),
        queryClient.invalidateQueries({ queryKey: ['low-stock', tenant.id] }),
      ])
      onClose()
    },
    onError: (cause) => setError(describe(cause, t)),
  })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background sm:items-center sm:justify-center sm:bg-foreground/20 sm:p-4">
      <div className="flex min-h-0 w-full flex-1 flex-col sm:max-h-[90vh] sm:max-w-lg sm:flex-none sm:rounded-xl sm:border sm:bg-background sm:shadow-lg">
        <header className="flex shrink-0 items-start gap-2 border-b p-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{t('inventory.adjustTitle')}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {row.productName}
              {row.sku ? ` · ${row.sku}` : ''} · {row.locationName}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* Current state first — the numbers she is reconciling against. */}
          <dl className="mb-4 grid grid-cols-3 gap-2 rounded-md bg-muted/60 p-3 text-center">
            <div>
              <dt className="text-xs text-muted-foreground">{t('inventory.onHand')}</dt>
              <dd className="text-lg font-semibold tabular">{row.onHand}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('inventory.reserved')}</dt>
              <dd className="text-lg font-semibold tabular">{row.reserved}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('inventory.available')}</dt>
              <dd
                className={cn(
                  'text-lg font-semibold tabular',
                  row.available === 0 && 'text-destructive',
                )}
              >
                {row.available}
              </dd>
            </div>
          </dl>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              mutation.mutate()
            }}
          >
            <div role="tablist" className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
              {(['relative', 'absolute'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={mode === option}
                  onClick={() => setMode(option)}
                  className={cn(
                    'min-h-9 rounded px-2 text-sm font-medium transition-colors',
                    mode === option
                      ? 'bg-background shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option === 'relative'
                    ? t('inventory.modeRelative')
                    : t('inventory.modeAbsolute')}
                </button>
              ))}
            </div>

            {mode === 'relative' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-delta">{t('inventory.deltaLabel')}</Label>
                <Input
                  id="stock-delta"
                  // `text` not `number`: a numeric input hides the minus sign behind
                  // a spinner on Android, and removing stock is half of what this
                  // form is for.
                  inputMode="numeric"
                  autoFocus
                  placeholder="+50"
                  value={delta}
                  onChange={(event) =>
                    setDelta(event.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, ''))
                  }
                />
                <p className="text-xs text-muted-foreground">{t('inventory.deltaHint')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-absolute">{t('inventory.absoluteLabel')}</Label>
                <Input
                  id="stock-absolute"
                  inputMode="numeric"
                  autoFocus
                  value={absolute}
                  onChange={(event) => setAbsolute(event.target.value.replace(/\D/g, ''))}
                />
              </div>
            )}

            {mode === 'relative' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-reason">{t('inventory.reasonLabel')}</Label>
                <Select
                  id="stock-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value as StockReason)}
                >
                  {MANUAL_STOCK_REASONS.map((option) => (
                    <option key={option} value={option}>
                      {t(`inventory.reason.${option}`)}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stock-note">{t('inventory.noteLabel')}</Label>
              <Input
                id="stock-note"
                placeholder={t('inventory.notePlaceholder')}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stock-threshold">{t('inventory.thresholdLabel')}</Label>
              <Input
                id="stock-threshold"
                inputMode="numeric"
                placeholder="5"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value.replace(/\D/g, ''))}
              />
              <p className="text-xs text-muted-foreground">{t('inventory.thresholdHint')}</p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={mutation.isPending} data-testid="save-adjustment">
              {mutation.isPending ? t('inventory.saving') : t('inventory.saveAdjustment')}
            </Button>
          </form>

          {/* The ledger: why the number above is what it is. */}
          <section className="mt-6">
            <h3 className="text-sm font-medium">{t('inventory.ledgerTitle')}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{t('inventory.ledgerHint')}</p>

            {movements.isLoading ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : (movements.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('inventory.ledgerEmpty')}</p>
            ) : (
              <ul className="flex flex-col divide-y" data-testid="stock-ledger">
                {movements.data?.map((movement) => (
                  <li key={movement.id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span
                      className={cn(
                        'w-12 shrink-0 text-right font-semibold tabular',
                        movement.delta > 0 ? 'text-primary' : 'text-destructive',
                      )}
                    >
                      {movement.delta > 0 ? `+${movement.delta}` : movement.delta}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{t(`inventory.reason.${movement.reason}`)}</span>
                      {movement.note && (
                        <span className="block text-xs text-muted-foreground">
                          {movement.note}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      {formatManilaDateTime(movement.createdAt)}
                      {movement.createdByName && (
                        <span className="block">{movement.createdByName}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

class DeltaError extends Error {
  constructor() {
    super('delta')
    this.name = 'DeltaError'
  }
}

function describe(cause: unknown, t: Translate): string {
  if (cause instanceof DeltaError) return t('inventory.errorDeltaZero')
  switch (describeStockError(cause)) {
    case 'insufficient_stock':
      return t('inventory.errorInsufficient')
    case 'not_allowed':
      return t('inventory.errorNotAllowed')
    default:
      return cause instanceof Error ? cause.message : t('errors.unexpected')
  }
}
