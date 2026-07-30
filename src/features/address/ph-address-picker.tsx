import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import type { PhAddressValue } from '@/features/address/ph-address'
import { useBarangays, useCities, useProvinces, useRegions } from '@/features/address/use-psgc'

export interface PhAddressPickerProps {
  value: PhAddressValue
  onChange: (next: PhAddressValue) => void
  /** Prefix for input ids, so two pickers can coexist on one page. */
  idPrefix?: string
  /** Hide street/landmark/postal, e.g. when only picking a shipping zone. */
  administrativeOnly?: boolean
  disabled?: boolean
}

/**
 * Cascading PSGC address picker: region → province → city → barangay.
 *
 * The structural wrinkle this component exists to absorb: **NCR has no
 * provinces**, and neither do independent cities like Isabela City — 19 cities in
 * total. So the province step is not a fixed level of the cascade, it is a step
 * that appears only when the selected region actually has provinces. Every form
 * that touches a PH address needs this behaviour, so it lives here once.
 */
export function PhAddressPicker({
  value,
  onChange,
  idPrefix = 'address',
  administrativeOnly = false,
  disabled = false,
}: PhAddressPickerProps) {
  const { t } = useTranslation()

  const regions = useRegions()
  const provinces = useProvinces(value.regionCode)
  const cities = useCities(value.regionCode, value.provinceCode)
  const barangays = useBarangays(value.cityCode)

  // NCR resolves to zero provinces. Until the query settles we do not know, so
  // treat "loaded and empty" as the signal rather than "empty".
  const hasProvinces = provinces.isSuccess && (provinces.data?.length ?? 0) > 0
  const provincesResolved = provinces.isSuccess || value.regionCode === null

  return (
    <div className="flex flex-col gap-4">
      <Field
        id={`${idPrefix}-region`}
        label={t('address.region')}
        hint={regions.isLoading ? t('common.loading') : undefined}
      >
        <Select
          id={`${idPrefix}-region`}
          value={value.regionCode ?? ''}
          disabled={disabled || regions.isLoading}
          onChange={(event) => {
            // Changing a level must clear everything below it, or the address
            // silently keeps a barangay from the previous province.
            onChange({
              ...value,
              regionCode: event.target.value || null,
              provinceCode: null,
              cityCode: null,
              barangayCode: null,
            })
          }}
        >
          <option value="">{t('address.selectRegion')}</option>
          {regions.data?.map((region) => (
            <option key={region.code} value={region.code}>
              {region.name} ({region.regionNumeral})
            </option>
          ))}
        </Select>
      </Field>

      {/* Rendered only when the region has provinces — NCR skips straight to city. */}
      {hasProvinces && (
        <Field id={`${idPrefix}-province`} label={t('address.province')}>
          <Select
            id={`${idPrefix}-province`}
            value={value.provinceCode ?? ''}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                provinceCode: event.target.value || null,
                cityCode: null,
                barangayCode: null,
              })
            }
          >
            <option value="">{t('address.selectProvince')}</option>
            {provinces.data?.map((province) => (
              <option key={province.code} value={province.code}>
                {province.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        id={`${idPrefix}-city`}
        label={t('address.city')}
        hint={
          value.regionCode !== null && hasProvinces && value.provinceCode === null
            ? t('address.pickProvinceFirst')
            : undefined
        }
      >
        <Select
          id={`${idPrefix}-city`}
          value={value.cityCode ?? ''}
          disabled={
            disabled ||
            value.regionCode === null ||
            !provincesResolved ||
            (hasProvinces && value.provinceCode === null) ||
            cities.isLoading
          }
          onChange={(event) =>
            onChange({ ...value, cityCode: event.target.value || null, barangayCode: null })
          }
        >
          <option value="">{t('address.selectCity')}</option>
          {cities.data?.map((city) => (
            // display_name, not name: PSA writes "City of Davao" but sellers and
            // buyers say "Davao City", and phase 7 matches shipping zones on this.
            <option key={city.code} value={city.code}>
              {city.displayName}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={`${idPrefix}-barangay`}
        label={t('address.barangay')}
        hint={t('address.barangayHint')}
      >
        <Select
          id={`${idPrefix}-barangay`}
          value={value.barangayCode ?? ''}
          disabled={disabled || value.cityCode === null || barangays.isLoading}
          onChange={(event) => onChange({ ...value, barangayCode: event.target.value || null })}
        >
          <option value="">{t('address.selectBarangay')}</option>
          {barangays.data?.map((barangay) => (
            <option key={barangay.code} value={barangay.code}>
              {barangay.name}
            </option>
          ))}
        </Select>
      </Field>

      {!administrativeOnly && (
        <>
          <Field id={`${idPrefix}-street`} label={t('address.street')}>
            <Input
              id={`${idPrefix}-street`}
              autoComplete="street-address"
              disabled={disabled}
              placeholder={t('address.streetPlaceholder')}
              value={value.street}
              onChange={(event) => onChange({ ...value, street: event.target.value })}
            />
          </Field>

          <Field
            id={`${idPrefix}-landmark`}
            label={t('address.landmark')}
            hint={t('address.landmarkHint')}
          >
            <Input
              id={`${idPrefix}-landmark`}
              disabled={disabled}
              placeholder={t('address.landmarkPlaceholder')}
              value={value.landmark}
              onChange={(event) => onChange({ ...value, landmark: event.target.value })}
            />
          </Field>

          <Field id={`${idPrefix}-postal`} label={t('address.postalCode')}>
            <Input
              id={`${idPrefix}-postal`}
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={4}
              disabled={disabled}
              placeholder="8000"
              value={value.postalCode}
              onChange={(event) =>
                onChange({
                  ...value,
                  postalCode: event.target.value.replace(/\D/g, '').slice(0, 4),
                })
              }
            />
          </Field>
        </>
      )}
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  // Explicit `| undefined` because exactOptionalPropertyTypes distinguishes
  // "absent" from "present and undefined", and callers pass a conditional.
  hint?: string | undefined
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
