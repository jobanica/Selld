import { fromDb, type Centavos } from '@/lib/money'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * Shipping zones and rates.
 *
 * Zone *areas* are rows with real foreign keys into PSGC rather than a JSONB list
 * of codes — see the migration header for why. The practical consequence here is
 * that adding an area can fail with a foreign-key error, which is the point: a
 * stale city code is rejected at write time instead of silently never matching.
 */

export type RateType = 'flat' | 'weight_tiered' | 'courier_live'
export type AreaLevel = 'region' | 'province' | 'city'

export interface ZoneArea {
  id: string
  level: AreaLevel
  code: string
  /** Resolved from PSGC for display; the code is what is stored. */
  name: string
}

export interface WeightTier {
  id: string
  /** null is the open-ended top band. */
  upToGrams: number | null
  price: Centavos
}

export interface ShippingRate {
  id: string
  name: string
  rateType: RateType
  flat: Centavos | null
  freeOver: Centavos | null
  isActive: boolean
  sortOrder: number
  tiers: WeightTier[]
}

export interface ShippingZone {
  id: string
  name: string
  isDefault: boolean
  sortOrder: number
  areas: ZoneArea[]
  rates: ShippingRate[]
}

interface AreaRow {
  id: string
  level: AreaLevel
  region_code: string | null
  province_code: string | null
  city_code: string | null
  psgc_regions: { name: string } | null
  psgc_provinces: { name: string } | null
  psgc_cities: { display_name: string } | null
}

interface RateRow {
  id: string
  name: string
  rate_type: RateType
  flat_centavos: number | null
  free_over_centavos: number | null
  is_active: boolean
  sort_order: number
  shipping_weight_tiers: { id: string; up_to_grams: number | null; price_centavos: number }[]
}

/**
 * Every zone with its areas and rates, in one query.
 *
 * PostgREST embeds do the joins, so this is one round trip rather than one per
 * zone — the shipping screen is the one place a seller sees their whole
 * configuration at once, and N+1 there is a visibly slow page.
 */
export async function fetchZones(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<ShippingZone[]> {
  const { data, error } = await client
    .from('shipping_zones')
    .select(
      `id, name, is_default, sort_order,
       shipping_zone_areas(id, level, region_code, province_code, city_code,
         psgc_regions(name), psgc_provinces(name), psgc_cities(display_name)),
       shipping_rates(id, name, rate_type, flat_centavos, free_over_centavos,
         is_active, sort_order,
         shipping_weight_tiers(id, up_to_grams, price_centavos))`,
    )
    .eq('tenant_id', tenantId)
    .order('sort_order')

  if (error) throw error

  return (data ?? [])
    .map((zone) => ({
      id: zone.id,
      name: zone.name,
      isDefault: zone.is_default,
      sortOrder: zone.sort_order,
      areas: ((zone.shipping_zone_areas ?? []) as unknown as AreaRow[]).map((area) => ({
        id: area.id,
        level: area.level,
        code: area.region_code ?? area.province_code ?? area.city_code ?? '',
        // `display_name` for cities, because PSA's canonical value is "City of Davao"
        // and no seller looks for that.
        name:
          area.psgc_cities?.display_name ??
          area.psgc_provinces?.name ??
          area.psgc_regions?.name ??
          '—',
      })),
      rates: ((zone.shipping_rates ?? []) as unknown as RateRow[])
        .map((rate) => ({
          id: rate.id,
          name: rate.name,
          rateType: rate.rate_type,
          flat: rate.flat_centavos === null ? null : fromDb(rate.flat_centavos),
          freeOver: rate.free_over_centavos === null ? null : fromDb(rate.free_over_centavos),
          isActive: rate.is_active,
          sortOrder: rate.sort_order,
          tiers: (rate.shipping_weight_tiers ?? [])
            .map((tier) => ({
              id: tier.id,
              upToGrams: tier.up_to_grams,
              price: fromDb(tier.price_centavos),
            }))
            // Open band last, matching how the resolver orders them.
            .sort(
              (a, b) =>
                (a.upToGrams ?? Number.MAX_SAFE_INTEGER) -
                (b.upToGrams ?? Number.MAX_SAFE_INTEGER),
            ),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    // Resolution order, not creation order — see `byResolutionOrder`.
    .sort(byResolutionOrder)
}

/** Specificity ranks, mirroring the `case a.level ...` ladder in `resolve_shipping_zone`. */
const AREA_RANK: Record<AreaLevel, number> = { city: 3, province: 2, region: 1 }

/**
 * How specific a zone's narrowest rule is: 3 city, 2 province, 1 region, 0 catch-all.
 *
 * A zone can hold rules at several levels, and the resolver matches each area
 * independently — a zone with both a city and a region area wins at 3 for that city
 * and at 1 for the rest of the region. The most specific rule it contains is the
 * honest one-number summary, because it answers the question a seller is actually
 * asking: can this zone beat the others?
 */
export function zoneSpecificity(zone: ShippingZone): number {
  if (zone.isDefault) return 0
  return zone.areas.reduce((best, area) => Math.max(best, AREA_RANK[area.level]), 0)
}

/**
 * Resolution order — most specific first, catch-all last.
 *
 * The shipping screen states "a city rule beats a province rule, which beats a
 * region rule, which beats the fallback" and then lists the zones. If that list is
 * not in that order the sentence is worse than absent: a seller reading top to bottom
 * sees the fallback first and concludes the fallback is what applies. It was, briefly
 * — `sort_order` defaults to 0 for every zone the UI creates, so the list came back
 * in creation order and the catch-all led it.
 *
 * `sort_order` is kept as the tiebreak between equally specific zones, which is the
 * same role it plays in the resolver.
 */
export function byResolutionOrder(a: ShippingZone, b: ShippingZone): number {
  const bySpecificity = zoneSpecificity(b) - zoneSpecificity(a)
  if (bySpecificity !== 0) return bySpecificity
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.name.localeCompare(b.name)
}

export async function createZone(
  input: { tenantId: string; name: string; isDefault: boolean },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const { data, error } = await client
    .from('shipping_zones')
    .insert({ tenant_id: input.tenantId, name: input.name, is_default: input.isDefault })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function renameZone(
  zoneId: string,
  name: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('shipping_zones').update({ name }).eq('id', zoneId)
  if (error) throw error
}

export async function deleteZone(
  zoneId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('shipping_zones').delete().eq('id', zoneId)
  if (error) throw error
}

export async function addArea(
  input: { tenantId: string; zoneId: string; level: AreaLevel; code: string },
  client: SelldClient = getSupabase(),
): Promise<void> {
  // All three columns set explicitly, with the unused two as null. That is exactly
  // what `shipping_zone_areas_level_matches_code` requires, so the row shape here
  // mirrors the constraint rather than relying on absent keys defaulting to null.
  //
  // Not a computed `[column]: code` key: that widens the object to
  // `Record<string, string>` and defeats the generated insert type — the very type
  // that stops a city code being written into `region_code`.
  const { error } = await client.from('shipping_zone_areas').insert({
    tenant_id: input.tenantId,
    zone_id: input.zoneId,
    level: input.level,
    region_code: input.level === 'region' ? input.code : null,
    province_code: input.level === 'province' ? input.code : null,
    city_code: input.level === 'city' ? input.code : null,
  })
  if (error) throw error
}

export async function removeArea(
  areaId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('shipping_zone_areas').delete().eq('id', areaId)
  if (error) throw error
}

export async function saveRate(
  input: {
    tenantId: string
    zoneId: string
    rateId?: string
    name: string
    rateType: RateType
    flat: Centavos | null
    freeOver: Centavos | null
  },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const row = {
    tenant_id: input.tenantId,
    zone_id: input.zoneId,
    name: input.name,
    rate_type: input.rateType,
    flat_centavos: input.flat,
    free_over_centavos: input.freeOver,
  }

  const { error } =
    input.rateId === undefined
      ? await client.from('shipping_rates').insert(row)
      : await client.from('shipping_rates').update(row).eq('id', input.rateId)
  if (error) throw error
}

export async function deleteRate(
  rateId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('shipping_rates').delete().eq('id', rateId)
  if (error) throw error
}

export async function seedPresets(
  input: { tenantId: string; metro: Centavos; rest: Centavos; freeOver: Centavos | null },
  client: SelldClient = getSupabase(),
): Promise<number> {
  const { data, error } = await client.rpc('seed_shipping_presets', {
    p_tenant_id: input.tenantId,
    p_metro_centavos: input.metro,
    p_rest_centavos: input.rest,
    ...(input.freeOver === null ? {} : { p_free_over: input.freeOver }),
  })
  if (error) throw error
  return data ?? 0
}

/**
 * Turn a write failure into something a seller can act on.
 *
 * These map one-to-one onto the schema's guards, and each message names the fix
 * rather than the constraint — "Quezon City is already in another zone" is
 * actionable; "shipping_zone_areas_city_idx" is not.
 */
export function describeShippingError(error: unknown): string {
  // `errorMessage`, not `error instanceof Error` — PostgREST hands back a plain
  // object on the non-throwOnError path, so an instanceof guard here sends every
  // one of these cases to `unknown`. See src/lib/supabase/errors.ts.
  const message = errorMessage(error).toLowerCase()
  if (message === '') return 'unknown'
  if (message.includes('shipping_zones_one_default_idx')) return 'one_default'
  if (message.includes('shipping_zone_areas_city_idx')) return 'area_taken'
  if (message.includes('shipping_zone_areas_province_idx')) return 'area_taken'
  if (message.includes('shipping_zone_areas_region_idx')) return 'area_taken'
  if (message.includes('shipping_zones_tenant_id_name_key')) return 'name_taken'
  if (message.includes('shipping_rates_flat_needs_amount')) return 'flat_needs_amount'
  if (message.includes('foreign key')) return 'unknown_place'
  if (message.includes('permission') || message.includes('not allowed')) return 'not_allowed'
  return 'unknown'
}

/**
 * A plain-language summary of what a zone charges.
 *
 * Exists so the seller can read their configuration back as the sentence they were
 * trying to express — the done-when for this phase is "₱80 Davao City, ₱150
 * Mindanao, ₱200 rest of PH, free over ₱2,000", and a screen that cannot say that
 * back has not really delivered it.
 */
export function describeRate(rate: ShippingRate | undefined): {
  kind: 'none' | 'flat' | 'weight_tiered' | 'courier_live'
  amount: Centavos | null
  freeOver: Centavos | null
  tierCount: number
} {
  if (rate === undefined) return { kind: 'none', amount: null, freeOver: null, tierCount: 0 }
  return {
    kind: rate.rateType,
    amount: rate.rateType === 'weight_tiered' ? null : rate.flat,
    freeOver: rate.freeOver,
    tierCount: rate.tiers.length,
  }
}
