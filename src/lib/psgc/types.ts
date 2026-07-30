/**
 * PSGC address vocabulary.
 *
 * A Philippine address is four levels deep — region, province, city/municipality,
 * barangay — with one structural exception that shapes every UI that touches it:
 * **NCR and independent cities have no province.** Modelling `province` as
 * optional here rather than faking a placeholder row keeps the data honest and
 * forces the cascade to handle the real case.
 */

export interface Region {
  code: string
  name: string
  /** "Region XI", "NCR" — the numeral most Filipinos recognise. */
  regionNumeral: string
  islandGroup: IslandGroup
}

export type IslandGroup = 'luzon' | 'visayas' | 'mindanao'

export interface Province {
  code: string
  name: string
  regionCode: string
}

export interface City {
  code: string
  /** Canonical PSA name: "City of Davao". */
  name: string
  /** Colloquial form, use this in UI: "Davao City". */
  displayName: string
  isCity: boolean
  isCapital: boolean
  /** `null` for NCR and independent cities. */
  provinceCode: string | null
  regionCode: string
}

export interface Barangay {
  code: string
  name: string
  cityCode: string
  /** Manila's districts (Tondo, Sampaloc, …). Buyers write these. */
  subMunicipalityCode: string | null
}

/** A fully-resolved address unit, as returned by `psgc_address_units`. */
export interface AddressUnit {
  barangayCode: string
  barangayName: string
  cityCode: string
  cityName: string
  cityDisplayName: string
  provinceCode: string | null
  provinceName: string | null
  regionCode: string
  regionName: string
  islandGroup: IslandGroup
  /** "Buhangin, Davao City, Davao Del Sur" */
  fullPath: string
}

/**
 * The address a buyer actually fills in at checkout.
 *
 * PSGC codes are stored alongside the human-readable names because the names are
 * what a courier's label needs and what the order snapshot must preserve, while
 * the codes are what rate matching and serviceability lookups need. Keeping both
 * means a later PSGC rename never rewrites history on past orders.
 */
export interface PhAddressInput {
  regionCode: string
  provinceCode: string | null
  cityCode: string
  barangayCode: string
  street: string
  postalCode?: string
  /** "Katabi ng Jollibee" — Filipino addresses lean on landmarks, not numbers. */
  landmark?: string
}

export function isIslandGroup(value: unknown): value is IslandGroup {
  return value === 'luzon' || value === 'visayas' || value === 'mindanao'
}
