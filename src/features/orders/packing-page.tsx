import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudOff, PackageCheck, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import {
  clearQueue,
  enqueueMove,
  readQueue,
  readSnapshot,
  saveSnapshot,
} from '@/lib/offline/offline-cache'
import { formatManilaDateTime } from '@/lib/time/manila'

import { bulkTransition, fetchOrders, type OrderRow } from './orders-api'

const SNAPSHOT = 'packing'

/**
 * The packing queue, readable with no signal.
 *
 * This is the one screen in the product used *away from the counter* — in a
 * stockroom, at the back of a building, on one bar. The rest of the dashboard can
 * reasonably say "you are offline"; this one cannot, because the packer is
 * holding the parcel and the alternative to reading it here is writing the list
 * on paper first.
 *
 * So it does two things nothing else does:
 *
 *   it **keeps the last good list** and renders it when the network is gone, with
 *   the time it was true printed on the screen rather than hidden — a stale list
 *   is useful and a stale list you believe is current is not;
 *
 *   it **queues the move** instead of failing it. A packer who has packed the
 *   parcel has done the work; refusing to record it because the signal dropped
 *   means they do it twice or not at all. `orders_bulk_transition` skips an order
 *   already in the target state, so replaying a queued move is safe by
 *   construction rather than by the flush being careful.
 */
export function PackingPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [online, setOnline] = useState(() => navigator.onLine)
  const [pending, setPending] = useState(() => readQueue(tenant.id))

  const queue = useQuery({
    queryKey: ['packing', tenant.id],
    queryFn: async () => {
      const page = await fetchOrders({ tenantId: tenant.id, view: 'to_pack', limit: 100 })
      saveSnapshot(SNAPSHOT, tenant.id, page.orders)
      return page.orders
    },
    // A packer refreshes by walking back into signal, not by pulling down.
    refetchInterval: online ? 30_000 : false,
    retry: online ? 2 : false,
  })

  const cached = readSnapshot<OrderRow[]>(SNAPSHOT, tenant.id)
  const orders = queue.data ?? cached?.data ?? []
  const showingCache = queue.data === undefined && cached !== null

  const pack = useMutation({
    mutationFn: (orderId: string) =>
      bulkTransition({ tenantId: tenant.id, orderIds: [orderId], toStatus: 'packed' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['packing', tenant.id] })
    },
    onError: (_error, orderId) => {
      // Whatever went wrong — no signal, a dead socket — the packer's work is
      // recorded rather than lost, and replayed when there is a network again.
      enqueueMove(tenant.id, { orderIds: [orderId], toStatus: 'packed' })
      setPending(readQueue(tenant.id))
    },
  })

  const flush = useMutation({
    mutationFn: async () => {
      const moves = readQueue(tenant.id)
      for (const move of moves) {
        await bulkTransition({
          tenantId: tenant.id,
          orderIds: move.orderIds,
          toStatus: move.toStatus as OrderRow['fulfillmentStatus'],
        })
      }
      clearQueue(tenant.id)
    },
    onSuccess: async () => {
      setPending([])
      await queryClient.invalidateQueries({ queryKey: ['packing', tenant.id] })
    },
  })

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  // Flush on the event, not on a timer: the browser tells us the moment the
  // network is back, and a packer walking out of a stockroom should not have to
  // wait out a polling interval to see their work land.
  useEffect(() => {
    if (online && pending.length > 0 && !flush.isPending) flush.mutate()
    // `flush` is a stable mutation object; depending on it would re-run this on
    // every render of a screen that is deliberately cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, pending.length])

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('packing.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('packing.subtitle')}</p>
      </header>

      {online ? null : (
        <p
          data-testid="offline-banner"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {t('packing.offline')}
            {cached === null
              ? ''
              : ` ${t('packing.lastKnown', { at: formatManilaDateTime(cached.at) })}`}
          </span>
        </p>
      )}

      {pending.length > 0 ? (
        <p
          data-testid="pending-banner"
          className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
        >
          <span>{t('packing.queued', { count: pending.length })}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-11"
            disabled={!online || flush.isPending}
            onClick={() => flush.mutate()}
          >
            <RefreshCw className="mr-1 size-3" aria-hidden="true" />
            {t('packing.sendNow')}
          </Button>
        </p>
      ) : null}

      {showingCache ? (
        <p className="text-xs text-muted-foreground">
          {cached === null
            ? null
            : t('packing.lastKnown', { at: formatManilaDateTime(cached.at) })}
        </p>
      ) : null}

      {orders.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('packing.empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2" data-testid="packing-list">
          {orders.map((order) => (
            <li key={order.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{order.orderNumber}</p>
                <p className="text-xs text-muted-foreground">
                  {t('packing.items', { count: order.itemCount })}
                </p>
              </div>
              <p className="mt-1 text-sm">{order.contactName}</p>
              <p className="text-xs text-muted-foreground">
                {order.city ?? ''}
                {order.province === null ? '' : `, ${order.province}`}
              </p>
              <Button
                className="mt-3 h-11 w-full"
                variant="outline"
                disabled={pack.isPending}
                onClick={() => pack.mutate(order.id)}
              >
                <PackageCheck className="mr-2 size-4" aria-hidden="true" />
                {t('packing.markPacked')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
