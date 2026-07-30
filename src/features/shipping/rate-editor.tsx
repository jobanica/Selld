import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, parsePesos, toPesoInputValue } from '@/lib/money'

import {
  describeShippingError,
  saveRate,
  type RateType,
  type ShippingZone,
} from './shipping-api'

/**
 * What a zone charges.
 *
 * Free-over-threshold is a field on whatever rate type is chosen, not a fourth
 * type — "₱200 rest of PH, free over ₱2,000" is one rule, and splitting it into two
 * rates that must agree is how they stop agreeing.
 */
export function RateEditor({
  zone,
  onChanged,
}: {
  zone: ShippingZone
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const existing = zone.rates[0]

  const [name, setName] = useState(existing?.name ?? 'Standard')
  const [rateType, setRateType] = useState<RateType>(existing?.rateType ?? 'flat')
  const [flat, setFlat] = useState(existing?.flat === null || existing?.flat === undefined ? '' : toPesoInputValue(existing.flat))
  const [freeOver, setFreeOver] = useState(
    existing?.freeOver === null || existing?.freeOver === undefined
      ? ''
      : toPesoInputValue(existing.freeOver),
  )
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      // `parsePesos` rejects more than two decimals rather than rounding, so a
      // fat-fingered "80.001" is a visible error instead of a silent ₱80.00.
      const flatCentavos = flat.trim() === '' ? null : parsePesos(flat)
      const freeCentavos = freeOver.trim() === '' ? null : parsePesos(freeOver)
      if (flat.trim() !== '' && flatCentavos === null) throw new Error('bad_amount')
      if (freeOver.trim() !== '' && freeCentavos === null) throw new Error('bad_amount')

      return saveRate({
        tenantId: tenant.id,
        zoneId: zone.id,
        ...(existing === undefined ? {} : { rateId: existing.id }),
        name: name.trim() === '' ? 'Standard' : name.trim(),
        rateType,
        flat: flatCentavos,
        freeOver: freeCentavos,
      })
    },
    onSuccess: async () => {
      setError(null)
      await onChanged()
    },
    onError: (cause) =>
      setError(cause instanceof Error && cause.message === 'bad_amount' ? 'bad_amount' : describeShippingError(cause)),
  })

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t('shippingConfig.rateHeading')}</h3>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {t(`shippingConfig.error.${error}` as 'shippingConfig.error.unknown')}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rate-name-${zone.id}`}>{t('shippingConfig.rateName')}</Label>
          <Input
            id={`rate-name-${zone.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rate-type-${zone.id}`}>{t('shippingConfig.rateType')}</Label>
          <Select
            id={`rate-type-${zone.id}`}
            value={rateType}
            onChange={(event) => setRateType(event.target.value as RateType)}
          >
            <option value="flat">{t('shippingConfig.typeFlat')}</option>
            <option value="weight_tiered">{t('shippingConfig.typeWeight')}</option>
            <option value="courier_live">{t('shippingConfig.typeCourier')}</option>
          </Select>
        </div>

        {rateType !== 'weight_tiered' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rate-flat-${zone.id}`}>
              {rateType === 'courier_live'
                ? t('shippingConfig.fallbackAmount')
                : t('shippingConfig.amount')}
            </Label>
            <Input
              id={`rate-flat-${zone.id}`}
              inputMode="decimal"
              placeholder="80.00"
              value={flat}
              onChange={(event) => setFlat(event.target.value)}
            />
            {rateType === 'courier_live' && (
              // Said plainly rather than left as a silent surprise: a live quote
              // needs a booked courier account, which is phase 10.
              <p className="text-xs text-muted-foreground">{t('shippingConfig.courierPending')}</p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rate-free-${zone.id}`}>{t('shippingConfig.freeOverLabel')}</Label>
          <Input
            id={`rate-free-${zone.id}`}
            inputMode="decimal"
            placeholder="2000.00"
            value={freeOver}
            onChange={(event) => setFreeOver(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('shippingConfig.freeOverHint')}</p>
        </div>
      </div>

      {rateType === 'weight_tiered' && (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">{t('shippingConfig.tiersHeading')}</p>
          {existing !== undefined && existing.tiers.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-1">
              {existing.tiers.map((tier) => (
                <li key={tier.id} className="flex justify-between text-muted-foreground">
                  <span>
                    {tier.upToGrams === null
                      ? t('shippingConfig.tierAbove')
                      : t('shippingConfig.tierUpTo', { grams: tier.upToGrams })}
                  </span>
                  <span className="tabular">{formatPHP(tier.price)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted-foreground">{t('shippingConfig.tiersEmpty')}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t('shippingConfig.tiersNote')}</p>
        </div>
      )}

      <Button
        type="button"
        className="self-start"
        onClick={() => save.mutate()}
        disabled={save.isPending}
      >
        {save.isPending ? t('shippingConfig.saving') : t('shippingConfig.saveRate')}
      </Button>
    </section>
  )
}
