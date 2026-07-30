import { describe, expect, it } from 'vitest'

import { isSettingKey, parseSettings, SETTING_DEFAULTS, SETTING_KEYS } from './keys'

describe('parseSettings()', () => {
  it('falls back to defaults when nothing is stored', () => {
    expect(parseSettings([])).toEqual(SETTING_DEFAULTS)
  })

  it('reads stored values', () => {
    const result = parseSettings([
      { key: 'payments.cod_enabled', value: false },
      { key: 'payments.cod_fee_centavos', value: 5000 },
      { key: 'orders.number_prefix', value: 'RF-' },
      { key: 'catalog.presets', value: ['skincare', 'rtw'] },
      { key: 'onboarding.step', value: 4 },
      { key: 'onboarding.completed_at', value: '2026-07-30T00:00:00Z' },
    ])
    expect(result['payments.cod_enabled']).toBe(false)
    expect(result['payments.cod_fee_centavos']).toBe(5000)
    expect(result['orders.number_prefix']).toBe('RF-')
    expect(result['catalog.presets']).toEqual(['skincare', 'rtw'])
    expect(result['onboarding.step']).toBe(4)
    expect(result['onboarding.completed_at']).toBe('2026-07-30T00:00:00Z')
  })

  it('ignores unknown keys instead of leaking them through', () => {
    const result = parseSettings([{ key: 'totally.made.up', value: 'x' }])
    expect(result).toEqual(SETTING_DEFAULTS)
    expect('totally.made.up' in result).toBe(false)
  })

  /**
   * The important behaviour. A malformed row must never reach pricing logic — a
   * COD fee of `"free"` becoming `NaN` would silently corrupt an order total.
   */
  it('falls back to the default for a malformed value rather than propagating it', () => {
    const result = parseSettings([
      { key: 'payments.cod_enabled', value: 'yes' },
      { key: 'payments.cod_fee_centavos', value: 'free' },
      { key: 'payments.cod_fee_bps', value: -100 },
      { key: 'onboarding.step', value: 99 },
      { key: 'catalog.presets', value: 'skincare' },
      { key: 'orders.number_prefix', value: 12 },
    ])
    expect(result['payments.cod_enabled']).toBe(SETTING_DEFAULTS['payments.cod_enabled'])
    expect(result['payments.cod_fee_centavos']).toBe(0)
    expect(result['payments.cod_fee_bps']).toBe(0)
    expect(result['onboarding.step']).toBe(1)
    expect(result['catalog.presets']).toEqual([])
    expect(result['orders.number_prefix']).toBe('')
  })

  it('rejects a fractional or unsafe COD fee', () => {
    expect(parseSettings([{ key: 'payments.cod_fee_centavos', value: 12.5 }])[
      'payments.cod_fee_centavos'
    ]).toBe(0)
    expect(parseSettings([{ key: 'payments.cod_fee_centavos', value: -1 }])[
      'payments.cod_fee_centavos'
    ]).toBe(0)
  })

  it('caps a percentage COD fee at 100%', () => {
    expect(parseSettings([{ key: 'payments.cod_fee_bps', value: 10_000 }])['payments.cod_fee_bps'])
      .toBe(10_000)
    expect(parseSettings([{ key: 'payments.cod_fee_bps', value: 10_001 }])['payments.cod_fee_bps'])
      .toBe(0)
  })

  it('accepts an explicit null completion timestamp — that is the unfinished state', () => {
    expect(parseSettings([{ key: 'onboarding.completed_at', value: null }])[
      'onboarding.completed_at'
    ]).toBeNull()
  })

  it('rejects an over-long order prefix', () => {
    expect(parseSettings([{ key: 'orders.number_prefix', value: 'WAY-TOO-LONG-PREFIX' }])[
      'orders.number_prefix'
    ]).toBe('')
  })
})

describe('the key catalogue', () => {
  it('every default has a key and vice versa', () => {
    expect(Object.keys(SETTING_DEFAULTS).sort()).toEqual([...SETTING_KEYS].sort())
  })

  it('keys match the database check constraint', () => {
    // tenant_settings.key is constrained to ^[a-z][a-z0-9_.]{1,60}$ — a key that
    // passes TS but fails the constraint would only fail at runtime.
    for (const key of SETTING_KEYS) {
      expect(key, key).toMatch(/^[a-z][a-z0-9_.]{1,60}$/)
    }
  })

  it('is a type guard', () => {
    expect(isSettingKey('payments.cod_enabled')).toBe(true)
    expect(isSettingKey('nope')).toBe(false)
  })
})
