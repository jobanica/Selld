import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import {
  describePaymentError,
  openRefund,
  recordCodRemittance,
  recordManualPayment,
  settleRefund,
} from '@/features/payments/payments-api'
import { formatPHP, parsePesos, toPesoInputValue, type Centavos } from '@/lib/money'
import { formatManilaDateTime } from '@/lib/time/manila'

import {
  addOrderNote,
  bulkTransition,
  describeOrderError,
  fetchOrderDetail,
  type FulfillmentStatus,
  type OrderDetail,
} from './orders-api'

/**
 * One order, everything about it.
 *
 * A full-screen sheet rather than a route, because a seller working a list is
 * mid-task: pushing a route and losing their scroll position and selection is what
 * makes them stop using the list and start opening orders one at a time.
 *
 * This is also where the phase-8 payment actions land. They were deferred there for
 * an honest reason — recording a bank transfer, remitting COD and refunding all act
 * on a single order, and there was no order screen to put them on. This is it.
 */
export function OrderDetailSheet({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string
  onClose: () => void
  onChanged: () => Promise<unknown> | unknown
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const detail = useQuery({
    queryKey: ['order-detail', orderId],
    queryFn: () => fetchOrderDetail(orderId),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['order-detail', orderId] })
    await onChanged()
  }

  const move = useMutation({
    mutationFn: (toStatus: FulfillmentStatus) =>
      bulkTransition({ tenantId: tenant.id, orderIds: [orderId], toStatus }),
    onSuccess: refresh,
    onError: (cause) => setError(describeOrderError(cause)),
  })

  const note$ = useMutation({
    mutationFn: () => addOrderNote({ orderId, body: note.trim() }),
    onSuccess: async () => {
      setNote('')
      await refresh()
    },
    onError: (cause) => setError(describeOrderError(cause)),
  })

  const order = detail.data

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-5" aria-hidden="true" />
        </Button>
        <h2 className="flex-1 truncate text-lg font-semibold">
          {order === undefined || order === null
            ? t('common.loading')
            : t('orders.orderNumber', { number: order.orderNumber })}
        </h2>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {order === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : order === null ? (
          <p className="text-sm text-muted-foreground">{t('orders.notFound')}</p>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            {error !== null && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              >
                {t(`orders.error.${error}` as 'orders.error.unknown')}
              </p>
            )}

            {/* Status actions, read from the database rather than guessed — the
                detail RPC returns exactly what this order may move to. */}
            {order.allowedTransitions.length > 0 && (
              <section className="flex flex-wrap gap-2">
                {order.allowedTransitions.map((status) => (
                  <Button
                    key={status}
                    onClick={() => move.mutate(status)}
                    disabled={move.isPending}
                    variant={status === 'cancelled' ? 'outline' : 'default'}
                  >
                    {t(`orders.action.${status}` as 'orders.action.packed')}
                  </Button>
                ))}
              </section>
            )}

            <Section title={t('orders.customer')}>
              <Row label={t('orders.name')} value={order.contactName} />
              <Row label={t('orders.phone')} value={order.contactPhone} />
              {order.contactEmail !== null && (
                <Row label={t('orders.email')} value={order.contactEmail} />
              )}
              <Row
                label={t('orders.address')}
                value={[
                  order.address['street'],
                  order.address['barangayName'],
                  order.address['cityName'],
                  order.address['provinceName'],
                  order.address['regionName'],
                ]
                  .filter(Boolean)
                  .join(', ')}
              />
              {typeof order.address['landmark'] === 'string' && order.address['landmark'] !== '' && (
                <Row label={t('orders.landmark')} value={order.address['landmark']} />
              )}
              {order.buyerNote !== null && order.buyerNote !== '' && (
                <Row label={t('orders.buyerNote')} value={order.buyerNote} />
              )}
            </Section>

            <Section title={t('orders.items')}>
              <ul className="flex flex-col divide-y text-sm">
                {order.items.map((item) => (
                  <li key={item.id} className="flex items-baseline gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      {item.productName}
                      {item.variantLabel === null ? '' : ` · ${item.variantLabel}`}
                      <span className="text-muted-foreground"> × {item.qty}</span>
                    </span>
                    <span className="shrink-0 tabular">{formatPHP(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>
              <dl className="mt-2 flex flex-col gap-1 text-sm">
                <Total label={t('orders.subtotal')} value={order.subtotal} />
                <Total label={t('orders.shipping')} value={order.shippingTotal} />
                {order.codFee > 0 && <Total label={t('orders.codFee')} value={order.codFee} />}
                <Total label={t('orders.total')} value={order.grandTotal} strong />
              </dl>
            </Section>

            <PaymentPanel order={order} onChanged={refresh} />

            <Section title={t('orders.internalNotes')}>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (note.trim() === '') return
                  note$.mutate()
                }}
              >
                <Input
                  aria-label={t('orders.addNote')}
                  placeholder={t('orders.notePlaceholder')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button type="submit" disabled={note.trim() === '' || note$.isPending}>
                  {t('orders.addNote')}
                </Button>
              </form>
              {/* Internal, and said so: this is the seller's own record, never the
                  buyer's message and never printed on a slip. */}
              <p className="mt-1 text-xs text-muted-foreground">{t('orders.notesAreInternal')}</p>
              <ul className="mt-2 flex flex-col gap-2 text-sm">
                {order.notes.map((entry) => (
                  <li key={entry.id} className="rounded-md bg-muted p-2">
                    <p>{entry.body}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {entry.authorName ?? t('orders.someone')} ·{' '}
                      {formatManilaDateTime(new Date(entry.createdAt))}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title={t('orders.timeline')}>
              <ol className="flex flex-col gap-2 text-sm">
                {order.timeline.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">
                      {entry.field === 'payment_status'
                        ? t(`orders.payment.${entry.toStatus}` as 'orders.payment.paid')
                        : t(`orders.status.${entry.toStatus}` as 'orders.status.pending')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatManilaDateTime(new Date(entry.createdAt))}
                      {entry.actorName === null ? '' : ` · ${entry.actorName}`}
                    </span>
                    {entry.note !== null && (
                      <span className="w-full text-xs text-muted-foreground">{entry.note}</span>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Money in and money back — the phase-8 actions, on the screen they belong to.
 *
 * Three distinct paths, kept distinct because they mean different things to a
 * seller's books: COD remitted by a courier, a payment that arrived outside any
 * provider, and a refund. Collapsing them into "mark paid" would make phase 12's
 * reconciliation unable to tell a remittance from a bank transfer.
 */
function PaymentPanel({
  order,
  onChanged,
}: {
  order: OrderDetail
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState('bank')
  const [amount, setAmount] = useState(toPesoInputValue(order.grandTotal))
  const [note, setNote] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')

  const settled = order.paymentStatus === 'paid'

  const manual = useMutation({
    mutationFn: () => {
      const centavos = parsePesos(amount)
      if (centavos === null) throw new Error('bad_amount')
      return recordManualPayment({
        orderId: order.id,
        method: method as 'bank',
        amount: centavos,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
    },
    onSuccess: async () => {
      setError(null)
      await onChanged()
    },
    onError: (cause) =>
      setError(
        cause instanceof Error && cause.message === 'bad_amount'
          ? 'bad_amount'
          : describePaymentError(cause),
      ),
  })

  const cod = useMutation({
    mutationFn: () => recordCodRemittance({ orderId: order.id }),
    onSuccess: async () => {
      setError(null)
      await onChanged()
    },
    onError: (cause) => setError(describePaymentError(cause)),
  })

  const refund = useMutation({
    mutationFn: async (paymentId: string) => {
      const centavos = parsePesos(refundAmount)
      if (centavos === null) throw new Error('bad_amount')
      const refundId = await openRefund({
        paymentId,
        amount: centavos,
        reason: refundReason.trim() === '' ? 'Refunded by the seller' : refundReason.trim(),
      })
      // A seller who sent the money back themselves settles it here; a provider
      // refund would be settled by its own webhook instead.
      await settleRefund({ refundId, status: 'succeeded' })
    },
    onSuccess: async () => {
      setRefundAmount('')
      setRefundReason('')
      setError(null)
      await onChanged()
    },
    onError: (cause) =>
      setError(
        cause instanceof Error && cause.message === 'bad_amount'
          ? 'bad_amount'
          : describePaymentError(cause),
      ),
  })

  const settledPayment = order.payments.find(
    (payment) => payment.status === 'paid' || payment.status === 'partially_refunded',
  )

  return (
    <Section title={t('orders.payment.heading')}>
      {error !== null && (
        <p role="alert" className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
          {t(`orders.error.${error}` as 'orders.error.unknown')}
        </p>
      )}

      <p className="text-sm">
        {t(`orders.method.${order.paymentMethod}` as 'orders.method.cod')}
        {' · '}
        <span className={settled ? 'text-success' : 'text-muted-foreground'}>
          {t(`orders.payment.${order.paymentStatus}` as 'orders.payment.unpaid')}
        </span>
      </p>

      {order.payments.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {order.payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap gap-x-2">
              <span>{payment.provider}</span>
              <span>{payment.method}</span>
              <span>{payment.status}</span>
              <span className="tabular">{formatPHP(payment.amount)}</span>
              {payment.refunded > 0 && (
                <span className="tabular">
                  {t('orders.refunded', { amount: formatPHP(payment.refunded) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {!settled && (
        <div className="mt-3 flex flex-col gap-3 rounded-md border p-3">
          {order.paymentMethod === 'cod' && (
            <div className="flex flex-col gap-1.5">
              <Button onClick={() => cod.mutate()} disabled={cod.isPending} className="self-start">
                {t('orders.recordCod')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('orders.recordCodHint')}</p>
            </div>
          )}

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              manual.mutate()
            }}
          >
            <p className="text-sm font-medium">{t('orders.recordManual')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="manual-method">{t('orders.method.label')}</Label>
                <Select
                  id="manual-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  <option value="bank">{t('orders.method.bank')}</option>
                  <option value="gcash">{t('orders.method.gcash')}</option>
                  <option value="maya">{t('orders.method.maya')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="manual-amount">{t('orders.amount')}</Label>
                <Input
                  id="manual-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
            </div>
            <Input
              aria-label={t('orders.reference')}
              placeholder={t('orders.referencePlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button type="submit" disabled={manual.isPending} className="self-start">
              {t('orders.recordPayment')}
            </Button>
          </form>
        </div>
      )}

      {settledPayment !== undefined && (
        <form
          className="mt-3 flex flex-col gap-2 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            refund.mutate(settledPayment.id)
          }}
        >
          <p className="text-sm font-medium">{t('orders.refund')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label={t('orders.refundAmount')}
              inputMode="decimal"
              placeholder={toPesoInputValue(
                (settledPayment.amount - settledPayment.refunded) as Centavos,
              )}
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
            />
            <Input
              aria-label={t('orders.refundReason')}
              placeholder={t('orders.refundReasonPlaceholder')}
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={refund.isPending || refundAmount.trim() === ''}
            className="self-start"
          >
            {t('orders.issueRefund')}
          </Button>
        </form>
      )}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex flex-wrap gap-x-2 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{value}</span>
    </p>
  )
}

function Total({ label, value, strong }: { label: string; value: Centavos; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong === true ? 'font-semibold' : ''}`}>
      <dt className={strong === true ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular">{formatPHP(value)}</dd>
    </div>
  )
}
