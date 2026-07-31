import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

import {
  describeCustomerError,
  fetchProfile,
  tagCustomer,
  untagCustomer,
} from './customers-api'

/**
 * One customer.
 *
 * The two numbers at the top are deliberately not one number. "₱2,400
 * delivered" is lifetime value; "₱800 on the way" is a parcel in a van, and a
 * seller who is about to offer a discount needs to know which they are looking
 * at. Blending them into "₱3,200 lifetime" is how a seller decides somebody is a
 * bigger customer than they are.
 *
 * The RTS rate is out of parcels that *reached a conclusion*, because an order
 * still in transit is not evidence either way — and a rate computed over
 * everything ever placed quietly flatters every new customer.
 */
export function CustomerPanel({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [tag, setTag] = useState('')
  const [error, setError] = useState<string | null>(null)

  const profile = useQuery({
    queryKey: ['customer-profile', customerId],
    queryFn: () => fetchProfile(customerId),
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['customer-profile', customerId] })
    await queryClient.invalidateQueries({ queryKey: ['customers', tenant.id] })
  }

  const addTag = useMutation({
    mutationFn: () => tagCustomer({ tenantId: tenant.id, customerId, name: tag.trim() }),
    onSuccess: async () => {
      setTag('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeCustomerError(cause)),
  })

  const removeTag = useMutation({
    mutationFn: (tagId: string) => untagCustomer({ customerId, tagId }),
    onSuccess: invalidate,
    onError: (cause) => setError(describeCustomerError(cause)),
  })

  const data = profile.data

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="h-11 px-2" onClick={onClose}>
          <ArrowLeft className="mr-1 size-4" aria-hidden="true" />
          {t('customers.backAction')}
        </Button>
        <h1 className="font-headline text-xl font-bold tracking-tight">{data?.name ?? ''}</h1>
      </header>

      <p className="text-sm text-muted-foreground">
        {data?.phone}
        {data?.email == null ? '' : ` · ${data.email}`}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">{t('customers.spentLabel')}</p>
            <p className="text-2xl font-bold tabular-nums">
              {formatPHP(fromDb(data?.stats.spent ?? 0))}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('customers.pendingLabel', {
                amount: formatPHP(fromDb(data?.stats.pending ?? 0)),
              })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">{t('customers.ordersLabel')}</p>
            <p className="text-2xl font-bold tabular-nums">{data?.stats.orders ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              {t('customers.rtsRateLabel', {
                rate: ((data?.stats.rtsRateBps ?? 0) / 100).toFixed(0),
                count: data?.stats.rts ?? 0,
              })}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('customers.tagsTitle')}</CardTitle>
          <CardDescription>{t('customers.tagsSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-2">
            {(data?.tags ?? []).map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="flex min-h-11 items-center gap-1 rounded-full bg-muted px-3 text-sm"
                  onClick={() => removeTag.mutate(entry.id)}
                >
                  {entry.name}
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input
              id="customer-tag"
              value={tag}
              placeholder={t('customers.tagPlaceholder')}
              onChange={(event) => setTag(event.target.value)}
            />
            <Button
              type="button"
              className="h-11 shrink-0"
              disabled={tag.trim() === '' || addTag.isPending}
              onClick={() => addTag.mutate()}
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'customers.errorUnknown')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('customers.historyTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.orders ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('customers.historyEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {(data?.orders ?? []).map((order) => (
                <li key={order.id} className="flex flex-col gap-1 py-3">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">#{order.number}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {t(
                        FULFILLMENT_LABELS[order.fulfillmentStatus as FulfillmentStatus] ??
                          'customers.statusUnknown',
                      )}
                    </span>
                    <span className="ml-auto tabular-nums">
                      {formatPHP(fromDb(order.total))}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatManilaDate(order.placedAt)} ·{' '}
                    {order.items.map((item) => `${item.qty}× ${item.name}`).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Every value `orders.fulfillment_status` can hold, and not one fewer.
 *
 * `as const` so the keys stay literal types — a `Record<string, string>` here
 * compiles and quietly loses the check that these are real translation keys.
 * A status missing from this map renders as a raw database word on a seller's
 * screen, which is the phase-11 lesson in a different costume.
 */
const FULFILLMENT_LABELS = {
  pending: 'customers.statusPending',
  confirmed: 'customers.statusConfirmed',
  packed: 'customers.statusPacked',
  shipped: 'customers.statusShipped',
  delivered: 'customers.statusDelivered',
  rts: 'customers.statusRts',
  cancelled: 'customers.statusCancelled',
} as const

export type FulfillmentStatus = keyof typeof FULFILLMENT_LABELS
