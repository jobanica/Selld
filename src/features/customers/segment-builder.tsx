import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import {
  deleteSegment,
  describeCustomerError,
  fetchSegments,
  previewSegment,
  saveSegment,
  type SegmentDefinition,
} from './customers-api'

/**
 * The segment builder.
 *
 * The count is the interface. A seller building "skincare buyers who have gone
 * quiet" is not composing a query, they are asking "how many people is that" —
 * and the answer moving from 412 to 38 as they add the second condition is what
 * tells them the thing works. So every control refetches the count, and the
 * count is the largest thing on the card.
 *
 * The controls are deliberately a fixed set. This is not a query builder with
 * fields and operators; it is the six questions a Filipino social seller
 * actually asks, in their own order. A seventh belongs here as a seventh
 * control, not as an escape hatch that takes text.
 */
export function SegmentBuilder({
  categories,
  onOpenCustomer,
}: {
  categories: { id: string; name: string }[]
  onOpenCustomer: (id: string) => void
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [definition, setDefinition] = useState<SegmentDefinition>({})
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const preview = useQuery({
    queryKey: ['segment-preview', tenant.id, definition],
    queryFn: () => previewSegment({ tenantId: tenant.id, definition }),
  })

  const segments = useQuery({
    queryKey: ['segments', tenant.id],
    queryFn: () => fetchSegments(tenant.id),
  })

  const save = useMutation({
    mutationFn: () =>
      saveSegment({ tenantId: tenant.id, id: null, name: name.trim(), definition, pinned: true }),
    onSuccess: async () => {
      setName('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['segments', tenant.id] })
    },
    onError: (cause) => setError(describeCustomerError(cause)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteSegment(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['segments', tenant.id] })
    },
    onError: (cause) => setError(describeCustomerError(cause)),
  })

  const set = (patch: Partial<SegmentDefinition>) =>
    setDefinition((current) => ({ ...current, ...patch }))

  const total = preview.data?.total ?? 0

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('customers.segmentTitle')}</CardTitle>
          <CardDescription>{t('customers.segmentSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-3xl font-bold tabular-nums">
            {t('customers.segmentCount', { count: total })}
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-category">{t('customers.segmentBought')}</Label>
            <select
              id="seg-category"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={definition.boughtCategoryId ?? ''}
              onChange={(event) => set({ boughtCategoryId: event.target.value || null })}
            >
              <option value="">{t('customers.segmentAnything')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-spent">{t('customers.segmentSpent')}</Label>
            <Input
              id="seg-spent"
              inputMode="numeric"
              placeholder="2000"
              value={
                definition.spentAtLeast == null ? '' : String(Math.round(definition.spentAtLeast / 100))
              }
              onChange={(event) => {
                // Pesos in the box, centavos on the wire. Hard rule 2 — the
                // multiplication is integer, and an empty box is "no bar" rather
                // than zero, which would mean something entirely different.
                const digits = event.target.value.replace(/[^0-9]/g, '')
                set({ spentAtLeast: digits === '' ? null : Number(digits) * 100 })
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-quiet">{t('customers.segmentQuiet')}</Label>
            <Input
              id="seg-quiet"
              inputMode="numeric"
              placeholder="60"
              value={definition.notOrderedForDays == null ? '' : String(definition.notOrderedForDays)}
              onChange={(event) => {
                const digits = event.target.value.replace(/[^0-9]/g, '')
                set({ notOrderedForDays: digits === '' ? null : Number(digits) })
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-rts">{t('customers.segmentRts')}</Label>
            <select
              id="seg-rts"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={definition.rts ?? ''}
              onChange={(event) =>
                set({ rts: (event.target.value || null) as 'none' | 'some' | null })
              }
            >
              <option value="">{t('customers.segmentRtsAny')}</option>
              <option value="none">{t('customers.segmentRtsNone')}</option>
              <option value="some">{t('customers.segmentRtsSome')}</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-orders">{t('customers.segmentOrders')}</Label>
            <Input
              id="seg-orders"
              inputMode="numeric"
              placeholder="2"
              value={definition.ordersAtLeast == null ? '' : String(definition.ordersAtLeast)}
              onChange={(event) => {
                const digits = event.target.value.replace(/[^0-9]/g, '')
                set({ ordersAtLeast: digits === '' ? null : Number(digits) })
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seg-name">{t('customers.segmentName')}</Label>
            <Input
              id="seg-name"
              value={name}
              placeholder={t('customers.segmentNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'customers.errorUnknown')}
            </p>
          )}

          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={name.trim() === '' || save.isPending}
            onClick={() => save.mutate()}
          >
            <Bookmark className="mr-2 size-4" aria-hidden="true" />
            {t('customers.segmentSaveAction')}
          </Button>

          {(preview.data?.customers ?? []).length > 0 && (
            <ul id="segment-preview" className="flex flex-col divide-y border-t pt-2">
              {(preview.data?.customers ?? []).slice(0, 10).map((customer) => (
                <li key={customer.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-2 py-2 text-left"
                    onClick={() => onOpenCustomer(customer.id)}
                  >
                    <span className="flex-1 truncate">{customer.name}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {formatPHP(fromDb(customer.spent))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {(segments.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('customers.savedTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {(segments.data ?? []).map((segment) => (
                <li key={segment.id} className="flex flex-wrap items-center gap-2 py-3">
                  <button
                    type="button"
                    className="min-h-11 flex-1 text-left"
                    onClick={() => setDefinition(segment.definition)}
                  >
                    <span className="font-medium">{segment.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('customers.segmentCount', { count: segment.count })}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 px-3"
                    aria-label={t('customers.segmentDelete')}
                    onClick={() => remove.mutate(segment.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
