import { useMutation, useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import { addItem, describeLiveError, fetchLiveVariants, type LiveConsole } from './live-api'

/**
 * Putting items on the board.
 *
 * The code is suggested rather than typed. A seller setting up thirty items before
 * a broadcast will not invent thirty codes, and the ones they do invent collide —
 * `A1` twice is a session where every claim on A1 is ambiguous and the parser
 * cannot help. So the next code in sequence is filled in, and they can override it.
 *
 * Rendered inline in the console rather than as a separate setup screen, because
 * sellers add items *during* a live sale when they find something in the pile they
 * forgot to list.
 */
export function LiveSetup({
  session,
  onChanged,
  compact = false,
}: {
  session: LiveConsole
  onChanged: () => Promise<unknown> | unknown
  compact?: boolean
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  // Initialised from `compact` and then left alone: a seller who opened the panel
  // keeps it open while they add the next item, and the next, and the next.
  const [open, setOpen] = useState(!compact)
  const [variantId, setVariantId] = useState('')
  const [code, setCode] = useState(nextCode(session))
  const [allocated, setAllocated] = useState('')
  const [error, setError] = useState<string | null>(null)

  const variantsQuery = useQuery({
    queryKey: ['live-variants', tenant.id],
    queryFn: () => fetchLiveVariants(tenant.id),
    enabled: open,
  })

  const add = useMutation({
    mutationFn: () =>
      addItem({
        sessionId: session.id,
        variantId,
        code: code.trim().toUpperCase(),
        allocated: allocated.trim() === '' ? null : Number(allocated.trim()),
      }),
    onSuccess: async (next) => {
      setError(null)
      setVariantId('')
      setAllocated('')
      setCode(nextCode(next))
      await onChanged()
    },
    onError: (cause) => setError(describeLiveError(cause)),
  })

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="mt-2 h-11 w-full"
        onClick={() => setOpen(true)}
      >
        <Plus className="mr-1.5 size-4" aria-hidden="true" />
        {t('live.addItemAction')}
      </Button>
    )
  }

  const variants = variantsQuery.data ?? []

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex gap-2">
        <div className="w-24 shrink-0">
          <Label htmlFor="live-code">{t('live.codeLabel')}</Label>
          <Input
            id="live-code"
            value={code}
            maxLength={5}
            className="uppercase"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="w-24 shrink-0">
          <Label htmlFor="live-alloc">{t('live.allocLabel')}</Label>
          <Input
            id="live-alloc"
            inputMode="numeric"
            placeholder={t('live.allocPlaceholder')}
            value={allocated}
            onChange={(event) => setAllocated(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="live-variant">{t('live.itemLabel')}</Label>
        <select
          id="live-variant"
          className="h-11 rounded-md border bg-background px-3 text-sm"
          value={variantId}
          onChange={(event) => setVariantId(event.target.value)}
        >
          <option value="">{t('live.itemPlaceholder')}</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.label} — {formatPHP(fromDb(variant.price))}
            </option>
          ))}
        </select>
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {t(error as 'live.errorUnknown')}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          className="h-11 flex-1"
          disabled={variantId === '' || code.trim() === '' || add.isPending}
          onClick={() => add.mutate()}
        >
          {t('live.addItemAction')}
        </Button>
        {compact && (
          <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The next code in the seller's own sequence.
 *
 * Reads the highest number already used on the board's most recent letter and adds
 * one, so a session set up as A1, A2, A3 offers A4 — matching what the seller is
 * already saying out loud rather than imposing a scheme.
 */
function nextCode(session: LiveConsole): string {
  const codes = session.items.map((item) => item.code.toUpperCase())
  if (codes.length === 0) return 'A1'

  const last = codes[codes.length - 1] ?? 'A1'
  const match = /^([A-Z]{1,2})(\d{1,3})$/.exec(last)
  if (match === null) return 'A1'

  const highest = Math.max(
    ...codes
      .filter((entry) => entry.startsWith(match[1]!))
      .map((entry) => Number(entry.slice(match[1]!.length)))
      .filter((value) => Number.isFinite(value)),
  )
  return `${match[1]}${highest + 1}`
}
