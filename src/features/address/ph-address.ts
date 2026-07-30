/**
 * The value a PH address form produces, and helpers over it.
 *
 * Split from the picker component so that file exports only a component — which
 * is what keeps Fast Refresh working. Also means non-UI code (order snapshots,
 * courier booking) can import the type without pulling in React.
 */

export interface PhAddressValue {
  regionCode: string | null
  /** `null` for NCR and independent cities, which genuinely have no province. */
  provinceCode: string | null
  cityCode: string | null
  barangayCode: string | null
  street: string
  landmark: string
  postalCode: string
}

export const EMPTY_PH_ADDRESS: PhAddressValue = {
  regionCode: null,
  provinceCode: null,
  cityCode: null,
  barangayCode: null,
  street: '',
  landmark: '',
  postalCode: '',
}

/**
 * The address is deliverable once it reaches barangay level and has a street.
 *
 * Province is deliberately not required: NCR and the independent cities have
 * none, so requiring it would make every Metro Manila address invalid.
 */
export function isAddressComplete(value: PhAddressValue): boolean {
  return (
    value.regionCode !== null &&
    value.cityCode !== null &&
    value.barangayCode !== null &&
    value.street.trim() !== ''
  )
}

/** True when enough is chosen to match a shipping zone, ignoring street detail. */
export function isAdministrativeComplete(value: PhAddressValue): boolean {
  return value.regionCode !== null && value.cityCode !== null
}
