import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parsePesos } from '@/lib/money'

import { describeCodError, recordRts, RTS_REASONS, type RtsReason } from './cod-api'

/**
 * Recording a return, asked properly.
 *
 * Phase 9's bulk action could already move an order to `rts`, and that was all it
 * did — the stock stayed "sold" and the shipping the seller had already paid
 * vanished from the books. This replaces that path for RTS specifically, because
 * the two facts that make a return actionable can only come from the person
 * holding the box:
 *
 * - **Is it saleable?** A parcel that spent two weeks on a van comes back opened,
 *   melted or with a broken seal often enough that "restock automatically" would
 *   quietly invent inventory that is not there. Default yes, one tap to say no.
 * - **What did the courier charge to bring it back?** Usually the same as the
 *   outbound leg, which is what is assumed when the field is left blank, and the
 *   real figure arrives with the next statement.
 *
 * Reason is required and comes from a fixed list rather than free text, because the
 * point of collecting it is the breakdown on the returns screen — and free text
 * does not group.
 */
export function RtsDialog({
  orderIds,
  onClose,
  onDone,
}: {
  orderIds: string[]
  onClose: () => void
  onDone: () => Promise<unknown> | unknown
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState<RtsReason>('buyer_unreachable')
  const [restock, setRestock] = useState(true)
  const [returnCost, setReturnCost] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: async () => {
      const cost = returnCost.trim() === '' ? null : parsePesos(returnCost.trim())
      let units = 0
      let recorded = 0
      // Sequential rather than in parallel: each call writes stock movements and
      // an order transition, and a seller doing twenty at once is better served by
      // a slightly slower loop than by twenty concurrent writes on one tenant.
      for (const orderId of orderIds) {
        const result = await recordRts({
          orderId,
          reason,
          restock,
          returnCost: cost === null ? null : (cost as number),
          note: note.trim() === '' ? null : note.trim(),
        })
        if (result.outcome === 'recorded') recorded += 1
        units += result.unitsReturned
      }
      return { recorded, units }
    },
    onSuccess: async () => {
      await onDone()
      onClose()
    },
    onError: (cause) => setError(describeCodError(cause)),
  })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true">
      <header className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-5" aria-hidden="true" />
        </Button>
        <h2 className="flex-1 text-lg font-semibold">
          {t('cod.rtsDialogTitle', { count: orderIds.length })}
        </h2>
      </header>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('cod.reasonLabel')}</legend>
          <div className="flex flex-col gap-2">
            {RTS_REASONS.map((option) => (
              <Button
                key={option}
                type="button"
                variant={reason === option ? 'default' : 'outline'}
                className="h-11 justify-start"
                aria-pressed={reason === option}
                onClick={() => setReason(option)}
              >
                {t(REASON_LABELS[option])}
              </Button>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('cod.restockLabel')}</p>
            <p className="text-xs text-muted-foreground">{t('cod.restockHint')}</p>
          </div>
          <Button
            type="button"
            variant={restock ? 'default' : 'outline'}
            className="h-11 shrink-0"
            aria-pressed={restock}
            onClick={() => setRestock(!restock)}
          >
            {restock ? t('cod.restockYes') : t('cod.restockNo')}
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rts-cost">{t('cod.returnCostLabel')}</Label>
          <Input
            id="rts-cost"
            inputMode="decimal"
            placeholder={t('cod.returnCostPlaceholder')}
            value={returnCost}
            onChange={(event) => setReturnCost(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('cod.returnCostHint')}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rts-note">{t('cod.noteLabel')}</Label>
          <Input
            id="rts-note"
            value={note}
            placeholder={t('cod.notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'cod.errorUnknown')}
          </p>
        )}
      </div>

      <footer className="border-t p-3">
        <Button
          type="button"
          className="h-11 w-full"
          disabled={submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? t('cod.rtsSaving')
            : t('cod.rtsConfirm', { count: orderIds.length })}
        </Button>
      </footer>
    </div>
  )
}

/** Literal keys, spelled out — a template literal would type-check as `string`. */
const REASON_LABELS = {
  buyer_unreachable: 'cod.reasonUnreachable',
  buyer_refused: 'cod.reasonRefused',
  wrong_address: 'cod.reasonWrongAddress',
  buyer_cancelled: 'cod.reasonCancelled',
  damaged: 'cod.reasonDamaged',
  other: 'cod.reasonOther',
} as const
