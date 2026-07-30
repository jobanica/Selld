import { useQuery } from '@tanstack/react-query'

import {
  listBarangays,
  listCities,
  listProvinces,
  listRegions,
  PSGC_QUERY_OPTIONS,
} from '@/lib/psgc'

/**
 * PSGC lookups as queries.
 *
 * The dataset only changes when the PSA publishes an update and we reseed, so
 * every one of these is cached indefinitely (`PSGC_QUERY_OPTIONS`). That matters
 * on mobile data: a seller filling in an address should pay for each level once
 * per session, not once per interaction.
 */

export function useRegions() {
  return useQuery({
    queryKey: ['psgc', 'regions'],
    queryFn: () => listRegions(),
    ...PSGC_QUERY_OPTIONS,
  })
}

export function useProvinces(regionCode: string | null) {
  return useQuery({
    queryKey: ['psgc', 'provinces', regionCode],
    queryFn: () => listProvinces(regionCode ?? ''),
    enabled: regionCode !== null,
    ...PSGC_QUERY_OPTIONS,
  })
}

/**
 * Cities for a region or province.
 *
 * Takes both codes and decides which lookup applies, because NCR and the
 * independent cities have no province — the caller should not have to remember
 * that. `listCities()` is where the branch actually lives.
 */
export function useCities(regionCode: string | null, provinceCode: string | null) {
  return useQuery({
    queryKey: ['psgc', 'cities', provinceCode ?? regionCode],
    queryFn: () =>
      provinceCode !== null
        ? listCities({ provinceCode })
        : listCities({ regionCode: regionCode ?? '' }),
    enabled: regionCode !== null,
    ...PSGC_QUERY_OPTIONS,
  })
}

export function useBarangays(cityCode: string | null) {
  return useQuery({
    queryKey: ['psgc', 'barangays', cityCode],
    queryFn: () => listBarangays(cityCode ?? ''),
    enabled: cityCode !== null,
    ...PSGC_QUERY_OPTIONS,
  })
}
