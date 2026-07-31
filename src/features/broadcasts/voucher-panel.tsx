import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Ticket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, fromDb } from '@/lib/money'

import {
  createDiscount,
  describeBroadcastError,
  fetchDiscounts,
  setDiscountActive,
} from './broadcasts-api'

/**
 * Vouchers.
 *
 * Three kinds and no more, because these are the three a Filipino social seller
 * actually runs: a percentage, a peso amount, and free shipping. Free shipping
 * is the one that sells: shipping is the commonest reason a PH cart is
 * abandoned, and "free shipping today" outperforms the equivalent peso discount
 * often enough that sellers ask for it by name.
 *
 * The usage counter beside each code is a projection of the redemptions table,
 * so "used 43 times" means forty-three orders exist — not that a counter was
 * incremented forty-three times.
 */
export function VoucherPanel() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [code, setCode] = useState('')
  const [kind, setKind] = useState<'percent' | 'fixed' | 'free_shipping'>('percent')
  const [value, setValue] = useState('')
  const [minimum, setMinimum] = useState('')
  const [error, setError] = useState<string | null>(null)

  const discounts = useQuery({
    queryKey: ['discounts', tenant.id],
    queryFn: () => fetchDiscounts(tenant.id),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['discounts', tenant.id] })

  const create = useMutation({
    mutationFn: () =>
      createDiscount({
        tenantId: tenant.id,
        code,
        name: code.trim().toUpperCase(),
        kind,
        value: Number(value || 0),
        minSubtotalPesos: Number(minimum || 0),
        // One per customer by default. A voucher a seller blasts to 800 people
        // and forgets to limit is a voucher one person uses forty times.
        perCustomer: 1,
      }),
    onSuccess: async () => {
      setCode('')
      setValue('')
      setMinimum('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeBroadcastError(cause)),
  })

  const toggle = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) => setDiscountActive(input),
    onSuccess: invalidate,
    onError: (cause) => setError(describeBroadcastError(cause)),
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Ticket className="size-4" aria-hidden="true" />
          {t('broadcasts.vouchersTitle')}
        </CardTitle>
        <CardDescription>{t('broadcasts.vouchersSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(discounts.data ?? []).length > 0 && (
          <ul className="flex flex-col divide-y">
            {(discounts.data ?? []).map((discount) => (
              <li key={discount.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                  {discount.code ?? t('broadcasts.voucherAuto')}
                </span>
                <span className={discount.is_active ? '' : 'text-muted-foreground line-through'}>
                  {discount.kind === 'percent'
                    ? t('broadcasts.voucherPercent', { value: discount.value / 100 })
                    : discount.kind === 'fixed'
                      ? t('broadcasts.voucherFixed', {
                          amount: formatPHP(fromDb(discount.value)),
                        })
                      : t('broadcasts.voucherFreeShipping')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('broadcasts.voucherUsed', { count: discount.used_count })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="ml-auto h-11"
                  onClick={() =>
                    toggle.mutate({ id: discount.id, isActive: !discount.is_active })
                  }
                >
                  {discount.is_active ? t('broadcasts.voucherOff') : t('broadcasts.voucherOn')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voucher-code">{t('broadcasts.voucherCodeLabel')}</Label>
            <Input
              id="voucher-code"
              value={code}
              placeholder="PAYDAY"
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voucher-kind">{t('broadcasts.voucherKindLabel')}</Label>
            <select
              id="voucher-kind"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as 'percent' | 'fixed' | 'free_shipping')
              }
            >
              <option value="percent">{t('broadcasts.voucherKindPercent')}</option>
              <option value="fixed">{t('broadcasts.voucherKindFixed')}</option>
              <option value="free_shipping">{t('broadcasts.voucherKindShipping')}</option>
            </select>
          </div>
          {kind !== 'free_shipping' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="voucher-value">
                {kind === 'percent'
                  ? t('broadcasts.voucherValuePercent')
                  : t('broadcasts.voucherValueFixed')}
              </Label>
              <Input
                id="voucher-value"
                inputMode="numeric"
                value={value}
                onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voucher-min">{t('broadcasts.voucherMinLabel')}</Label>
            <Input
              id="voucher-min"
              inputMode="numeric"
              value={minimum}
              onChange={(event) => setMinimum(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>

          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'broadcasts.errorUnknown')}
            </p>
          )}

          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={code.trim().length < 3 || create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {t('broadcasts.voucherCreateAction')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
