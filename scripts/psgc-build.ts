/**
 * Fetch the PSGC dataset from the PSA mirror, validate it, and write a compact
 * seed file to `supabase/seed/psgc.json.gz`.
 *
 *   pnpm psgc:build
 *
 * The generated file is committed. Builds and CI must not depend on a
 * third-party API being reachable, and PSGC changes a handful of times a year
 * (new cities, renamed barangays, the occasional new province), so regenerating
 * is a deliberate act with a reviewable diff — not a build step.
 *
 * Run this again when the PSA publishes an update, then `pnpm psgc:seed`.
 */

import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_BASE = 'https://psgc.gitlab.io/api'
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../supabase/seed/psgc.json.gz',
)

const ISLAND_GROUPS = new Set(['luzon', 'visayas', 'mindanao'])

interface ApiRegion {
  code: string
  name: string
  regionName: string
  islandGroupCode: string
}

interface ApiProvince {
  code: string
  name: string
  regionCode: string
  islandGroupCode: string
}

interface ApiCity {
  code: string
  name: string
  oldName: string
  isCapital: boolean
  isCity: boolean
  isMunicipality: boolean
  provinceCode: string | false
  districtCode: string | false
  regionCode: string
  islandGroupCode: string
}

interface ApiBarangay {
  code: string
  name: string
  oldName: string
  subMunicipalityCode: string | false
  cityCode: string | false
  municipalityCode: string | false
  provinceCode: string | false
  regionCode: string
}

/** Shape written to disk — already matches the table columns. */
export interface PsgcSeed {
  generatedAt: string
  source: string
  regions: { code: string; name: string; region_name: string; island_group: string }[]
  provinces: { code: string; name: string; region_code: string; island_group: string }[]
  cities: {
    code: string
    name: string
    old_name: string | null
    is_capital: boolean
    is_city: boolean
    is_municipality: boolean
    province_code: string | null
    district_code: string | null
    region_code: string
    island_group: string
  }[]
  barangays: {
    code: string
    name: string
    old_name: string | null
    city_code: string
    sub_municipality_code: string | null
    province_code: string | null
    region_code: string
  }[]
}

async function fetchJson<T>(path: string): Promise<T[]> {
  const url = `${API_BASE}/${path}/`
  process.stdout.write(`  GET ${url} … `)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as T[]
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${url} returned no records`)
  }
  console.log(`${data.length} records`)
  return data
}

/** `false` and `''` both mean "not applicable" in this API. */
function optional(value: string | false | undefined | null): string | null {
  if (value === false || value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function required(value: string | false | undefined | null, context: string): string {
  const result = optional(value)
  if (result === null) throw new Error(`Missing required value: ${context}`)
  return result
}

function assertUnique(codes: string[], label: string): void {
  const seen = new Set<string>()
  for (const code of codes) {
    if (seen.has(code)) throw new Error(`Duplicate ${label} code: ${code}`)
    seen.add(code)
  }
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code.localeCompare(b.code)
}

async function main(): Promise<void> {
  console.log('Fetching PSGC reference data…')
  const [apiRegions, apiProvinces, apiCities, apiBarangays] = await Promise.all([
    fetchJson<ApiRegion>('regions'),
    fetchJson<ApiProvince>('provinces'),
    fetchJson<ApiCity>('cities-municipalities'),
    fetchJson<ApiBarangay>('barangays'),
  ])

  const regions = apiRegions.map((r) => ({
    code: required(r.code, 'region.code'),
    name: required(r.name, `region ${r.code} name`),
    region_name: required(r.regionName, `region ${r.code} regionName`),
    island_group: required(r.islandGroupCode, `region ${r.code} islandGroupCode`),
  }))

  const provinces = apiProvinces.map((p) => ({
    code: required(p.code, 'province.code'),
    name: required(p.name, `province ${p.code} name`),
    region_code: required(p.regionCode, `province ${p.code} regionCode`),
    island_group: required(p.islandGroupCode, `province ${p.code} islandGroupCode`),
  }))

  const cities = apiCities.map((c) => ({
    code: required(c.code, 'city.code'),
    name: required(c.name, `city ${c.code} name`),
    old_name: optional(c.oldName),
    is_capital: Boolean(c.isCapital),
    is_city: Boolean(c.isCity),
    is_municipality: Boolean(c.isMunicipality),
    province_code: optional(c.provinceCode),
    district_code: optional(c.districtCode),
    region_code: required(c.regionCode, `city ${c.code} regionCode`),
    island_group: required(c.islandGroupCode, `city ${c.code} islandGroupCode`),
  }))

  const barangays = apiBarangays.map((b) => ({
    code: required(b.code, 'barangay.code'),
    name: required(b.name, `barangay ${b.code} name`),
    old_name: optional(b.oldName),
    // The API splits the parent across two fields depending on whether the
    // parent is a city or a municipality. Exactly one is always populated.
    city_code: required(
      optional(b.cityCode) ?? optional(b.municipalityCode),
      `barangay ${b.code} has neither cityCode nor municipalityCode`,
    ),
    sub_municipality_code: optional(b.subMunicipalityCode),
    province_code: optional(b.provinceCode),
    region_code: required(b.regionCode, `barangay ${b.code} regionCode`),
  }))

  console.log('\nValidating referential integrity…')

  assertUnique(regions.map((r) => r.code), 'region')
  assertUnique(provinces.map((p) => p.code), 'province')
  assertUnique(cities.map((c) => c.code), 'city')
  assertUnique(barangays.map((b) => b.code), 'barangay')

  const regionCodes = new Set(regions.map((r) => r.code))
  const provinceCodes = new Set(provinces.map((p) => p.code))
  const cityCodes = new Set(cities.map((c) => c.code))

  for (const group of [regions, provinces, cities]) {
    for (const row of group) {
      if (!ISLAND_GROUPS.has(row.island_group)) {
        throw new Error(`Unexpected island group "${row.island_group}" on ${row.code}`)
      }
    }
  }

  for (const p of provinces) {
    if (!regionCodes.has(p.region_code)) {
      throw new Error(`Province ${p.code} references unknown region ${p.region_code}`)
    }
  }
  for (const c of cities) {
    if (!regionCodes.has(c.region_code)) {
      throw new Error(`City ${c.code} references unknown region ${c.region_code}`)
    }
    if (c.province_code !== null && !provinceCodes.has(c.province_code)) {
      throw new Error(`City ${c.code} references unknown province ${c.province_code}`)
    }
  }
  for (const b of barangays) {
    if (!cityCodes.has(b.city_code)) {
      throw new Error(`Barangay ${b.code} references unknown city ${b.city_code}`)
    }
    if (b.province_code !== null && !provinceCodes.has(b.province_code)) {
      throw new Error(`Barangay ${b.code} references unknown province ${b.province_code}`)
    }
  }

  const provincelessCities = cities.filter((c) => c.province_code === null)
  console.log(`  ✓ ${regions.length} regions`)
  console.log(`  ✓ ${provinces.length} provinces`)
  console.log(`  ✓ ${cities.length} cities/municipalities`)
  console.log(`      ${provincelessCities.length} without a province (NCR + independent cities)`)
  console.log(`  ✓ ${barangays.length} barangays`)

  const seed: PsgcSeed = {
    // Recorded so a stale seed file is obvious in review.
    generatedAt: new Date().toISOString(),
    source: API_BASE,
    regions: regions.sort(byCode),
    provinces: provinces.sort(byCode),
    cities: cities.sort(byCode),
    barangays: barangays.sort(byCode),
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  const json = JSON.stringify(seed)
  const compressed = gzipSync(json, { level: 9 })
  writeFileSync(OUT_PATH, compressed)

  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`
  console.log(`\nWrote ${OUT_PATH}`)
  console.log(`  ${mb(json.length)} raw -> ${mb(compressed.length)} gzipped`)
  console.log('\nNext: pnpm psgc:seed')
}

main().catch((error: unknown) => {
  console.error('\npsgc:build failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
