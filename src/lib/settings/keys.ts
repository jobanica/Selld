/**
 * The catalogue of `tenant_settings` keys.
 *
 * `tenant_settings` is deliberately key/value in the database — checkout rules,
 * COD policy, order prefixes and packing-slip config arrive across many phases,
 * and a wide table would mean a migration plus a types regeneration for every new
 * option. The cost of that flexibility is that nothing stops a typo'd key, so this
 * file is the compensating control: the key set and each value's shape live here,
 * typed, in one place.
 *
 * Add a key here before using it. `readSettings()` validates against this map, so
 * an unknown or malformed value falls back to the default rather than propagating
 * `undefined` into pricing logic.
 */

import { centavos, type Bps, type Centavos } from '@/lib/money'

export type SettingKey =
  | 'onboarding.step'
  | 'onboarding.completed_at'
  | 'payments.cod_enabled'
  | 'payments.cod_fee_centavos'
  | 'payments.cod_fee_bps'
  | 'payments.online_enabled'
  | 'orders.number_prefix'
  | 'orders.auto_confirm'
  | 'catalog.presets'
  | 'shipping.flat_centavos'
  | 'risk.contribute_signal'
  | 'risk.use_shared_signal'
  | 'analytics.subscription_centavos'
  | 'analytics.marketplace_commission_bps'

export interface TenantSettings {
  /** Which wizard step to resume at, 1-5. */
  'onboarding.step': number
  /** ISO timestamp, or null while onboarding is unfinished. */
  'onboarding.completed_at': string | null
  'payments.cod_enabled': boolean
  /** Flat COD handling fee. */
  'payments.cod_fee_centavos': Centavos
  /** Percentage COD fee in basis points, applied on top of the flat fee. */
  'payments.cod_fee_bps': Bps
  /** Online payments require Xendit, which lands in phase 8. */
  'payments.online_enabled': boolean
  /** Prefix on order numbers, e.g. `RF-`. Sellers read these aloud. */
  'orders.number_prefix': string
  'orders.auto_confirm': boolean
  /** Chosen category presets from onboarding; phase 3 seeds categories from these. */
  'catalog.presets': string[]
  /**
   * Flat shipping charge, applied to every order.
   *
   * Phase 7 replaces the *resolver* — zones by region/province/city, weight tiers,
   * free-over-threshold, live courier quotes — not this key. Checkout could not
   * wait for that, and a store that ships everything free by default is worse than
   * one that charges a stated flat rate.
   */
  'shipping.flat_centavos': Centavos
  /**
   * Whether this store adds its buyers' delivery history to the cross-tenant
   * risk pool, hashed and without a tenant id attached.
   *
   * Off by default and only ever turned on deliberately. However anonymised the
   * pool is, contributing a customer's history to it is a decision a seller makes
   * knowingly or not at all.
   */
  'risk.contribute_signal': boolean
  /**
   * Whether the checkout and the returns screen show what *other* stores have
   * seen about a phone number.
   *
   * Separate from contributing, and gated on it: reading without contributing is
   * a free ride on other sellers' data, so `buyer_risk_lookup` requires both.
   */
  'risk.use_shared_signal': boolean
  /**
   * What Selld costs this store per month.
   *
   * A cost like any other, and it belongs in the profit subtraction for the same
   * reason ad spend does: a seller asking whether they made money is asking after
   * *everything*, and a platform that quietly leaves its own fee out of that sum
   * is the one thing on the screen with a motive.
   *
   * Pro-rated by days when the window is not a whole month. Phase 19 replaces
   * this with the real subscription; until then it is a number a seller types.
   */
  'analytics.subscription_centavos': Centavos
  /**
   * What a marketplace would have charged on the same sales, in basis points.
   *
   * 550 by default — roughly Shopee and Lazada's PH non-mall commission once the
   * payment fee is added. It is a setting rather than a constant because the rate
   * differs by category and by seller tier, and a retention counter built on a
   * number the seller knows to be wrong is worse than no counter.
   */
  'analytics.marketplace_commission_bps': Bps
}

export const SETTING_DEFAULTS: TenantSettings = {
  'onboarding.step': 1,
  'onboarding.completed_at': null,
  'payments.cod_enabled': true,
  'payments.cod_fee_centavos': centavos(0),
  'payments.cod_fee_bps': 0 as Bps,
  'payments.online_enabled': false,
  'orders.number_prefix': '',
  'orders.auto_confirm': false,
  'catalog.presets': [],
  // ₱80 is the going rate for a Metro Manila small-parcel COD delivery.
  'shipping.flat_centavos': centavos(8000),
  'risk.contribute_signal': false,
  'risk.use_shared_signal': false,
  'analytics.subscription_centavos': centavos(0),
  'analytics.marketplace_commission_bps': 550 as Bps,
}

type Parser<K extends SettingKey> = (raw: unknown) => TenantSettings[K] | undefined

/**
 * Per-key parsers. Each returns `undefined` for a value it cannot trust, and the
 * caller substitutes the default — a bad row must never surface as `NaN` in a
 * total or `undefined` in a COD fee.
 */
const PARSERS: { [K in SettingKey]: Parser<K> } = {
  'onboarding.step': (raw) =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : undefined,
  'onboarding.completed_at': (raw) =>
    raw === null ? null : typeof raw === 'string' && raw !== '' ? raw : undefined,
  'payments.cod_enabled': (raw) => (typeof raw === 'boolean' ? raw : undefined),
  'payments.cod_fee_centavos': (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? (raw as Centavos)
      : undefined,
  'shipping.flat_centavos': (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? (raw as Centavos)
      : undefined,
  'payments.cod_fee_bps': (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 10_000
      ? (raw as Bps)
      : undefined,
  'payments.online_enabled': (raw) => (typeof raw === 'boolean' ? raw : undefined),
  'analytics.subscription_centavos': (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? (raw as Centavos)
      : undefined,
  'analytics.marketplace_commission_bps': (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 10_000
      ? (raw as Bps)
      : undefined,
  'orders.number_prefix': (raw) =>
    typeof raw === 'string' && raw.length <= 8 ? raw : undefined,
  'orders.auto_confirm': (raw) => (typeof raw === 'boolean' ? raw : undefined),
  'risk.contribute_signal': (raw) => (typeof raw === 'boolean' ? raw : undefined),
  'risk.use_shared_signal': (raw) => (typeof raw === 'boolean' ? raw : undefined),
  'catalog.presets': (raw) =>
    Array.isArray(raw) && raw.every((item) => typeof item === 'string')
      ? (raw as string[])
      : undefined,
}

export const SETTING_KEYS = Object.keys(PARSERS) as SettingKey[]

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as string[]).includes(value)
}

/**
 * Build a fully-populated settings object from raw rows, falling back to the
 * default for anything missing or malformed.
 */
export function parseSettings(
  rows: readonly { key: string; value: unknown }[],
): TenantSettings {
  const result: TenantSettings = { ...SETTING_DEFAULTS }

  for (const row of rows) {
    if (!isSettingKey(row.key)) continue
    // The indexed access below is sound but not narrowable by TS across a union
    // of key/parser pairs, so assert once here rather than at every call site.
    const parser = PARSERS[row.key] as Parser<SettingKey>
    const parsed = parser(row.value)
    if (parsed !== undefined) {
      ;(result as Record<SettingKey, unknown>)[row.key] = parsed
    }
  }

  return result
}
