import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Package, Printer, Search, Truck, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'
import { cn } from '@/lib/utils'

import { OrderDetailSheet } from './order-detail-sheet'
import { PackingSheet } from './packing-sheet'
import {
  ORDER_VIEWS,
  bulkTransition,
  describeOrderError,
  fetchOrders,
  type FulfillmentStatus,
  type OrderRow,
  type OrderView,
} from './orders-api'
import { availableActions } from './transitions'
import {
  bookShipments,
  describeCourierError,
  downloadLabels,
} from '@/features/couriers/couriers-api'

/**
 * The order screen.
 *
 * The done-when is a stopwatch — 50 orders from `confirmed` to `packed` in under 60
 * seconds — and every decision here is downstream of it:
 *
 * - **Saved views are tabs, not filters.** "To pack" is a question a seller asks
 *   twenty times a day. Rebuilding it from three dropdowns each time is how a
 *   dashboard becomes something they avoid.
 * - **Select-all selects the whole view**, not the visible page. The seller's intent
 *   is "pack today's orders", and making them scroll to select is where the 60
 *   seconds would actually go.
 * - **One bulk call for the batch.** See `bulkTransition`.
 * - **Rows are cards on a phone, not a table.** A seller packs one-handed, standing
 *   over a parcel; a horizontally scrolling table is unusable in that posture.
 */
export function OrdersPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [view, setView] = useState<OrderView>('to_pack')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const [packingIds, setPackingIds] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ moved: number; skipped: number } | null>(null)
  /**
   * Booking gets its own message rather than reusing the bulk-move one.
   *
   * It first said "Moved 48, skipped 2 that had already moved" for a batch where two
   * parcels had *failed* — which points a seller at the wrong explanation entirely,
   * and hides the fact that two orders need attention.
   */
  const [bookResult, setBookResult] = useState<
    { booked: number; failed: number; alreadyBooked: number } | null
  >(null)

  const orders = useQuery({
    queryKey: ['orders', tenant.id, view, submittedSearch],
    queryFn: () => fetchOrders({ tenantId: tenant.id, view, search: submittedSearch, limit: 200 }),
  })

  const rows = orders.data?.orders ?? []
  const counts = orders.data?.counts

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['orders', tenant.id] })

  const move = useMutation({
    mutationFn: (toStatus: FulfillmentStatus) =>
      bulkTransition({ tenantId: tenant.id, orderIds: [...selected], toStatus }),
    onSuccess: async (outcome) => {
      setResult({ moved: outcome.moved, skipped: outcome.skipped })
      setSelected(new Set())
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeOrderError(cause)),
  })

  /**
   * What this selection can be moved to.
   *
   * Intersected across the selected rows and derived from their statuses, so a mixed
   * selection only offers what every row can actually do. Offering an action the
   * server will skip for half the batch is worse than not offering it — the seller
   * taps it, sees "25 moved, 25 skipped", and has to work out why.
   */
  const selectedRows = rows.filter((row) => selected.has(row.id))
  const actions = availableActions(selectedRows)

  /**
   * Booking is offered for a selection that is packed and ready to hand over.
   *
   * Not for `confirmed` orders: booking moves them straight to shipped, so a parcel
   * would get a waybill before anyone put anything in a box.
   */
  const canBook = selectedRows.length > 0 && selectedRows.every((row) => row.fulfillmentStatus === 'packed')
  const canPrintLabels = selectedRows.length > 0 && selectedRows.every((row) => row.fulfillmentStatus === 'shipped')

  const book = useMutation({
    mutationFn: () =>
      bookShipments({ tenantId: tenant.id, orderIds: [...selected], courier: 'jnt' }),
    onSuccess: async (outcome) => {
      setBookResult(outcome)
      setResult(null)
      setSelected(new Set())
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeCourierError(cause)),
  })

  const labels = useMutation({
    mutationFn: () => downloadLabels({ tenantId: tenant.id, orderIds: [...selected] }),
    onError: (cause) => setError(describeCourierError(cause)),
  })

  const allSelected = rows.length > 0 && selected.size === rows.length

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('orders.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('orders.intro')}</p>
        </div>
      </header>

      {/*
        Saved views. Horizontally scrollable on a phone rather than wrapped into
        three rows that push the list below the fold.

        No negative-margin "bleed to the screen edge" here. It was `-mx-4 px-4`,
        which silently assumes the shell's content padding is 16px — it is `px-3`,
        and `sm:px-6 lg:px-8` after that. The strip started 4px left of the viewport
        and pushed the document 4px wide at 390px, which is a horizontal scrollbar on
        the one screen a seller uses most. Scrolling inside the column is worth more
        than reaching the edge.
      */}
      <div className="overflow-x-auto">
        <div className="flex w-max gap-1.5">
          {ORDER_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setView(candidate)
                setSelected(new Set())
                setResult(null)
                setBookResult(null)
              }}
              className={cn(
                'flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition-colors',
                candidate === view
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {t(`orders.view.${candidate}` as 'orders.view.all')}
              {counts !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs tabular',
                    candidate === view ? 'bg-primary-foreground/20' : 'bg-muted',
                  )}
                >
                  {counts[candidate] ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* One search box for four fields. A seller looking at a Messenger thread has a
          phone number or a name and does not know which column it lives in. */}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmittedSearch(search.trim())
          setSelected(new Set())
        }}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={t('orders.searchLabel')}
            placeholder={t('orders.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline">
          {t('orders.search')}
        </Button>
        {submittedSearch !== '' && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('orders.clearSearch')}
            onClick={() => {
              setSearch('')
              setSubmittedSearch('')
            }}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        )}
      </form>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {t(`orders.error.${error}` as 'orders.error.unknown')}
        </p>
      )}

      {bookResult !== null && (
        <p
          role="status"
          className={
            bookResult.failed > 0
              ? 'rounded-md border border-warning/40 bg-warning/10 p-3 text-sm'
              : 'rounded-md border border-success/40 bg-success/10 p-3 text-sm'
          }
        >
          {bookResult.failed > 0
            ? t('orders.bookedSome', { count: bookResult.booked, failed: bookResult.failed })
            : t('orders.bookedAll', { count: bookResult.booked })}
          {bookResult.alreadyBooked > 0
            ? ` ${t('orders.bookedAlready', { count: bookResult.alreadyBooked })}`
            : ''}
        </p>
      )}

      {result !== null && (
        <p role="status" className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
          {result.skipped === 0
            ? t('orders.movedAll', { count: result.moved })
            : t('orders.movedSome', { count: result.moved, skipped: result.skipped })}
        </p>
      )}

      {/* The action bar. Sticky at the bottom on a phone so it stays under the thumb
          while the seller scrolls a long list — the alternative is scrolling back to
          the top after every selection. */}
      {selected.size > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-3 backdrop-blur">
          <span className="text-sm font-medium">
            {t('orders.selectedCount', { count: selected.size })}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                onClick={() => move.mutate(action)}
                disabled={move.isPending}
                size={action === 'cancelled' ? 'default' : 'default'}
                variant={action === 'cancelled' ? 'outline' : 'default'}
              >
                {t(`orders.action.${action}` as 'orders.action.packed')}
              </Button>
            ))}
            <Button variant="outline" onClick={() => setPackingIds([...selected])}>
              <Printer className="size-4" aria-hidden="true" />
              {t('orders.print')}
            </Button>
            {canBook && (
              <Button onClick={() => book.mutate()} disabled={book.isPending}>
                <Truck className="size-4" aria-hidden="true" />
                {book.isPending ? t('orders.booking') : t('orders.bookCourier')}
              </Button>
            )}
            {canPrintLabels && (
              <Button variant="outline" onClick={() => labels.mutate()} disabled={labels.isPending}>
                <Download className="size-4" aria-hidden="true" />
                {t('orders.downloadLabels')}
              </Button>
            )}
          </div>
        </div>
      )}

      {orders.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader className="items-start gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Package className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base">{t('orders.empty')}</CardTitle>
            <CardDescription>
              {submittedSearch === '' ? t('orders.emptyBody') : t('orders.emptySearch')}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <label className="flex min-h-11 items-center gap-3 px-1 text-sm">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) =>
                setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
              }
              className="size-4 accent-[var(--primary)]"
            />
            {t('orders.selectAll', { count: rows.length })}
          </label>

          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id}>
                <OrderCard
                  row={row}
                  selected={selected.has(row.id)}
                  onToggle={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      return next
                    })
                  }
                  onOpen={() => setOpenOrderId(row.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {openOrderId !== null && (
        <OrderDetailSheet
          orderId={openOrderId}
          onClose={() => setOpenOrderId(null)}
          onChanged={invalidate}
        />
      )}

      {packingIds !== null && (
        <PackingSheet orderIds={packingIds} onClose={() => setPackingIds(null)} />
      )}
    </div>
  )
}

function OrderCard({
  row,
  selected,
  onToggle,
  onOpen,
}: {
  row: OrderRow
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 transition-colors',
        selected && 'border-primary bg-primary/5',
      )}
    >
      {/* The checkbox has its own 44px target, separate from the row's open action:
          selecting and opening are different intents and must not be one tap apart. */}
      <label className="flex min-h-11 items-center pl-1 pr-1">
        <span className="sr-only">{t('orders.selectOne', { number: row.orderNumber })}</span>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="size-4 accent-[var(--primary)]"
        />
      </label>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium tabular">{row.orderNumber}</span>
          <StatusPill status={row.fulfillmentStatus} />
          {row.paymentStatus !== 'paid' && row.paymentMethod === 'cod' && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {t('orders.cod')}
            </span>
          )}
          {row.paymentStatus === 'paid' && (
            <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
              {t('orders.paid')}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-sm">{row.contactName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[row.city, row.province].filter(Boolean).join(', ') || row.contactPhone}
          {' · '}
          {t('orders.itemCount', { count: row.itemCount })}
          {' · '}
          {formatManilaDateTime(new Date(row.placedAt))}
        </span>
      </button>

      <span className="shrink-0 text-sm font-medium tabular">{formatPHP(row.grandTotal)}</span>
    </div>
  )
}

function StatusPill({ status }: { status: FulfillmentStatus }) {
  const { t } = useTranslation()
  const tone: Record<FulfillmentStatus, string> = {
    pending: 'bg-warning/15 text-warning',
    confirmed: 'bg-primary/15 text-primary',
    packed: 'bg-primary/15 text-primary',
    shipped: 'bg-muted text-muted-foreground',
    delivered: 'bg-success/15 text-success',
    rts: 'bg-destructive/15 text-destructive',
    cancelled: 'bg-muted text-muted-foreground',
  }
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        tone[status],
      )}
    >
      {t(`orders.status.${status}` as 'orders.status.pending')}
    </span>
  )
}
