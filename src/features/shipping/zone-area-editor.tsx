import { useMutation, useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { listCities, listProvinces, listRegions } from '@/lib/psgc/queries'

import {
  addArea,
  describeShippingError,
  removeArea,
  type AreaLevel,
  type ShippingZone,
} from './shipping-api'

/**
 * What a zone covers.
 *
 * Three levels, and the level is chosen explicitly rather than inferred from a
 * search box. "Mindanao" is six regions and "Davao City" is one city; a seller
 * needs to say which granularity they mean, because picking regions when they
 * meant cities silently produces a much broader zone than intended.
 */
export function ZoneAreaEditor({
  zone,
  onChanged,
}: {
  zone: ShippingZone
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const [level, setLevel] = useState<AreaLevel>('region')
  const [regionCode, setRegionCode] = useState('')
  const [provinceCode, setProvinceCode] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const regions = useQuery({ queryKey: ['psgc-regions'], queryFn: () => listRegions() })

  const provinces = useQuery({
    queryKey: ['psgc-provinces', regionCode],
    queryFn: () => listProvinces(regionCode),
    enabled: regionCode !== '' && (level === 'province' || level === 'city'),
  })

  // `listCities` is the helper that encapsulates the NCR shortcut: 19 cities have
  // `province_code IS NULL`, so a region → city lookup has to be supported directly
  // rather than always going through a province.
  const cities = useQuery({
    queryKey: ['psgc-cities', regionCode, provinceCode],
    // A discriminated union on purpose: pass the province when there is one, the
    // region when there is not. That is the NCR shortcut, kept in one place.
    queryFn: () =>
      listCities(provinceCode === '' ? { regionCode } : { provinceCode }),
    enabled: regionCode !== '' && level === 'city',
  })

  const add = useMutation({
    mutationFn: () => addArea({ tenantId: tenant.id, zoneId: zone.id, level, code }),
    onSuccess: async () => {
      setCode('')
      setError(null)
      await onChanged()
    },
    onError: (cause) => setError(describeShippingError(cause)),
  })

  const remove = useMutation({
    mutationFn: (areaId: string) => removeArea(areaId),
    onSuccess: onChanged,
    onError: (cause) => setError(describeShippingError(cause)),
  })

  const options =
    level === 'region'
      ? (regions.data ?? []).map((r) => ({ code: r.code, name: r.name }))
      : level === 'province'
        ? (provinces.data ?? []).map((p) => ({ code: p.code, name: p.name }))
        : (cities.data ?? []).map((c) => ({ code: c.code, name: c.displayName }))

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t('shippingConfig.areasHeading')}</h3>

      {zone.areas.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {zone.areas.map((area) => (
            <li key={area.id}>
              {/*
                The pill is 44px tall because it contains a destructive control. A
                24px X is comfortable with a mouse and a coin-flip with a thumb, and
                the thing it does — silently widen or narrow what the store ships to
                — is not one to mis-tap. The icon stays visually small; only the
                target grows.
              */}
              <span className="flex items-center gap-1 rounded-full border pl-3 pr-0.5 text-xs">
                {area.name}
                <button
                  type="button"
                  aria-label={t('shippingConfig.removeArea', { name: area.name })}
                  onClick={() => remove.mutate(area.id)}
                  className="grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {t(`shippingConfig.error.${error}` as 'shippingConfig.error.unknown')}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`level-${zone.id}`}>{t('shippingConfig.level')}</Label>
          <Select
            id={`level-${zone.id}`}
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as AreaLevel)
              setCode('')
            }}
          >
            <option value="region">{t('shippingConfig.levelRegion')}</option>
            <option value="province">{t('shippingConfig.levelProvince')}</option>
            <option value="city">{t('shippingConfig.levelCity')}</option>
          </Select>
        </div>

        {level !== 'region' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`region-${zone.id}`}>{t('shippingConfig.inRegion')}</Label>
            <Select
              id={`region-${zone.id}`}
              value={regionCode}
              onChange={(event) => {
                setRegionCode(event.target.value)
                setProvinceCode('')
                setCode('')
              }}
            >
              <option value="">{t('shippingConfig.selectRegion')}</option>
              {(regions.data ?? []).map((region) => (
                <option key={region.code} value={region.code}>
                  {region.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        {level === 'city' && regionCode !== '' && (provinces.data ?? []).length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`province-${zone.id}`}>{t('shippingConfig.inProvince')}</Label>
            <Select
              id={`province-${zone.id}`}
              value={provinceCode}
              onChange={(event) => {
                setProvinceCode(event.target.value)
                setCode('')
              }}
            >
              {/* Blank is meaningful for NCR, whose cities have no province. */}
              <option value="">{t('shippingConfig.anyProvince')}</option>
              {(provinces.data ?? []).map((province) => (
                <option key={province.code} value={province.code}>
                  {province.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`area-${zone.id}`}>{t('shippingConfig.area')}</Label>
          <div className="flex gap-2">
            <Select
              id={`area-${zone.id}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={options.length === 0}
            >
              <option value="">
                {options.length === 0
                  ? t('shippingConfig.chooseRegionFirst')
                  : t('shippingConfig.selectArea')}
              </option>
              {options.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              onClick={() => add.mutate()}
              disabled={code === '' || add.isPending}
              className="shrink-0"
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('shippingConfig.addArea')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
