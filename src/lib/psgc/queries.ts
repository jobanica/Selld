import { getSupabase, type SelldClient } from '@/lib/supabase/client'

import {
  isIslandGroup,
  type AddressUnit,
  type Barangay,
  type City,
  type IslandGroup,
  type Province,
  type Region,
} from './types'

/**
 * Read-side helpers for the PSGC reference tables.
 *
 * These power the cascading address picker at checkout (phase 6) and shipping
 * zone configuration (phase 7). PSGC data is immutable between seeds, so every
 * query here is a good candidate for a long TanStack Query `staleTime` —
 * see {@link PSGC_QUERY_OPTIONS}.
 */

/** PSGC only changes when the PSA publishes an update and we reseed. */
export const PSGC_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 24 * 60 * 60 * 1000,
} as const

function islandGroupOrThrow(value: string | null, context: string): IslandGroup {
  if (!isIslandGroup(value)) {
    throw new Error(`Unexpected island group "${value}" on ${context}`)
  }
  return value
}

export async function listRegions(client: SelldClient = getSupabase()): Promise<Region[]> {
  const { data, error } = await client
    .from('psgc_regions')
    .select('code, name, region_name, island_group')
    .order('code')

  if (error) throw error
  return data.map((row) => ({
    code: row.code,
    name: row.name,
    regionNumeral: row.region_name,
    islandGroup: islandGroupOrThrow(row.island_group, `region ${row.code}`),
  }))
}

/**
 * Provinces in a region. **Returns an empty array for NCR** — that is not an
 * error, it is the structure. Callers should fall through to
 * {@link listCitiesInRegion} when this is empty.
 */
export async function listProvinces(
  regionCode: string,
  client: SelldClient = getSupabase(),
): Promise<Province[]> {
  const { data, error } = await client
    .from('psgc_provinces')
    .select('code, name, region_code')
    .eq('region_code', regionCode)
    .order('name')

  if (error) throw error
  return data.map((row) => ({
    code: row.code,
    name: row.name,
    regionCode: row.region_code,
  }))
}

const CITY_COLUMNS = 'code, name, display_name, is_city, is_capital, province_code, region_code'

function toCity(row: {
  code: string
  name: string
  display_name: string
  is_city: boolean
  is_capital: boolean
  province_code: string | null
  region_code: string
}): City {
  return {
    code: row.code,
    name: row.name,
    displayName: row.display_name,
    isCity: row.is_city,
    isCapital: row.is_capital,
    provinceCode: row.province_code,
    regionCode: row.region_code,
  }
}

export async function listCitiesInProvince(
  provinceCode: string,
  client: SelldClient = getSupabase(),
): Promise<City[]> {
  const { data, error } = await client
    .from('psgc_cities')
    .select(CITY_COLUMNS)
    .eq('province_code', provinceCode)
    .order('display_name')

  if (error) throw error
  return data.map(toCity)
}

/**
 * Cities that belong directly to a region with no province in between — the NCR
 * case, plus independent cities like Isabela City.
 */
export async function listCitiesInRegion(
  regionCode: string,
  client: SelldClient = getSupabase(),
): Promise<City[]> {
  const { data, error } = await client
    .from('psgc_cities')
    .select(CITY_COLUMNS)
    .eq('region_code', regionCode)
    .is('province_code', null)
    .order('display_name')

  if (error) throw error
  return data.map(toCity)
}

/**
 * One call that resolves the correct next step of the cascade.
 *
 * Pass the province when there is one, otherwise the region. This is the
 * function the address picker should use so the NCR special case lives in
 * exactly one place instead of in every form.
 */
export async function listCities(
  location: { provinceCode: string } | { regionCode: string },
  client: SelldClient = getSupabase(),
): Promise<City[]> {
  return 'provinceCode' in location
    ? listCitiesInProvince(location.provinceCode, client)
    : listCitiesInRegion(location.regionCode, client)
}

export async function listBarangays(
  cityCode: string,
  client: SelldClient = getSupabase(),
): Promise<Barangay[]> {
  const { data, error } = await client
    .from('psgc_barangays')
    .select('code, name, city_code, sub_municipality_code')
    .eq('city_code', cityCode)
    .order('name')

  if (error) throw error
  return data.map((row) => ({
    code: row.code,
    name: row.name,
    cityCode: row.city_code,
    subMunicipalityCode: row.sub_municipality_code,
  }))
}

function toAddressUnit(row: {
  barangay_code: string | null
  barangay_name: string | null
  city_code: string | null
  city_name: string | null
  city_display_name: string | null
  province_code: string | null
  province_name: string | null
  region_code: string | null
  region_name: string | null
  island_group: string | null
  full_path: string | null
}): AddressUnit {
  // The view's columns are nullable in the generated types because Postgres
  // discards not-null information through a view. The joins guarantee these are
  // present, so narrow once here rather than at every call site.
  if (
    row.barangay_code === null ||
    row.barangay_name === null ||
    row.city_code === null ||
    row.city_name === null ||
    row.city_display_name === null ||
    row.region_code === null ||
    row.region_name === null ||
    row.full_path === null
  ) {
    throw new Error(`Incomplete PSGC address unit: ${JSON.stringify(row)}`)
  }

  return {
    barangayCode: row.barangay_code,
    barangayName: row.barangay_name,
    cityCode: row.city_code,
    cityName: row.city_name,
    cityDisplayName: row.city_display_name,
    provinceCode: row.province_code,
    provinceName: row.province_name,
    regionCode: row.region_code,
    regionName: row.region_name,
    islandGroup: islandGroupOrThrow(row.island_group, `barangay ${row.barangay_code}`),
    fullPath: row.full_path,
  }
}

const ADDRESS_UNIT_COLUMNS =
  'barangay_code, barangay_name, city_code, city_name, city_display_name, province_code, province_name, region_code, region_name, island_group, full_path'

/** Resolve one barangay to its full path — used when snapshotting an order address. */
export async function getAddressUnit(
  barangayCode: string,
  client: SelldClient = getSupabase(),
): Promise<AddressUnit | null> {
  const { data, error } = await client
    .from('psgc_address_units')
    .select(ADDRESS_UNIT_COLUMNS)
    .eq('barangay_code', barangayCode)
    .maybeSingle()

  if (error) throw error
  return data ? toAddressUnit(data) : null
}

/**
 * Free-text barangay search across the whole country, backed by the trigram
 * indexes. Optionally scoped to a city, which is how the checkout picker uses it.
 *
 * Scoping matters: there are 42,046 barangays and names repeat constantly
 * ("Poblacion" appears in hundreds of municipalities), so an unscoped search is
 * only useful with the full path shown alongside each result.
 */
export async function searchBarangays(
  query: string,
  options: { cityCode?: string; limit?: number } = {},
  client: SelldClient = getSupabase(),
): Promise<AddressUnit[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  let request = client
    .from('psgc_address_units')
    .select(ADDRESS_UNIT_COLUMNS)
    .ilike('barangay_name', `%${trimmed}%`)
    .order('barangay_name')
    .limit(options.limit ?? 20)

  if (options.cityCode !== undefined) {
    request = request.eq('city_code', options.cityCode)
  }

  const { data, error } = await request
  if (error) throw error
  return data.map(toAddressUnit)
}
