import { describe, expect, it } from 'vitest'

import { createI18nInstance, resources, SUPPORTED_LOCALES } from './index'

/**
 * Plural keys.
 *
 * These exist because the project shipped three broken ones. i18next used the
 * `key_plural` suffix in v3; from v21 the JSON v4 format expects CLDR category
 * suffixes (`key_one`, `key_other`). Nothing warns about the old form — the
 * lookup simply misses and falls back to the singular, so `catalog.variantCount`
 * rendered "3 variant" and `inventory.lowStockCount` rendered "4 item is low on
 * stock" for two whole phases while every test passed.
 *
 * The lesson is that a plural key can be wrong without anything failing, so the
 * convention has to be asserted structurally rather than trusted.
 */
describe('plural keys', () => {
  const flatten = (value: object, prefix = ''): Record<string, string> =>
    Object.entries(value).reduce<Record<string, string>>((accumulator, [key, entry]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (typeof entry === 'string') accumulator[path] = entry
      else if (entry !== null && typeof entry === 'object') {
        Object.assign(accumulator, flatten(entry as object, path))
      }
      return accumulator
    }, {})

  it.each(SUPPORTED_LOCALES)('%s uses CLDR category suffixes, never _plural', (locale) => {
    const keys = Object.keys(flatten(resources[locale].common))
    expect(keys.filter((key) => key.endsWith('_plural'))).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)('%s pairs every _one with an _other', (locale) => {
    const keys = Object.keys(flatten(resources[locale].common))
    const missing = keys
      .filter((key) => key.endsWith('_one'))
      .map((key) => key.replace(/_one$/, '_other'))
      .filter((expected) => !keys.includes(expected))

    // A lone `_one` is the same failure in a new costume: the lookup for any
    // other count misses and i18next falls back to the key itself.
    expect(missing).toEqual([])
  })

  it('en actually renders a different string for 1 and for many', () => {
    const i18n = createI18nInstance('en')
    expect(i18n.t('catalog.variantCount', { count: 1 })).toBe('1 variant')
    expect(i18n.t('catalog.variantCount', { count: 3 })).toBe('3 variants')
    expect(i18n.t('inventory.lowStockCount', { count: 1 })).toBe('1 item is low on stock')
    expect(i18n.t('inventory.lowStockCount', { count: 4 })).toBe('4 items are low on stock')
  })

  it('tl reads correctly at every count', () => {
    // Tagalog nouns are not inflected for number, and CLDR puts 2 and 3 in tl's
    // `one` category for exactly that reason. So the two forms carry the same
    // text here — an English-style split would render "2 item", which is the
    // machine-translation tell the Taglish rule exists to avoid.
    const i18n = createI18nInstance('tl')
    for (const count of [1, 2, 3, 5, 11]) {
      expect(i18n.t('storefront.productCount', { count }), `count=${count}`).toBe(`${count} item`)
    }
  })

  it('tl gives _one and _other the same text, for every plural key', () => {
    // Asserting one key by hand is what let seventeen others through. CLDR's
    // rule for `fil` sends everything except counts ending in 4, 6 or 9 to
    // `one`, so a split pair does not read as "singular vs plural" — it reads as
    // "790 credit" beside "6 credits", which is worse than either.
    const strings = flatten(resources.tl.common)
    const split = Object.keys(strings)
      .filter((key) => key.endsWith('_one'))
      .filter((key) => strings[key.replace(/_one$/, '_other')] !== strings[key])
    expect(split).toEqual([])
  })

  it('tl renders the same noun at 1, at 6 and at 790', () => {
    // The rendering half of the assertion above: 6 is one of the few counts CLDR
    // routes to `other` in fil, and 790 is the one a payday broadcast shows.
    const i18n = createI18nInstance('tl')
    const keys = ['broadcasts.costCredits', 'customers.listTitle', 'orders.itemCount'] as const
    for (const key of keys) {
      const shapes = new Set(
        [1, 6, 790].map((count) => i18n.t(key, { count }).replace(String(count), '#')),
      )
      expect([...shapes], key).toHaveLength(1)
    }
  })

  it('no key resolves to its own name — the fallback signature of a bad lookup', () => {
    const i18n = createI18nInstance('en')
    const keys = [
      'catalog.variantCount',
      'inventory.lowStockCount',
      'storefront.productCount',
    ] as const
    for (const count of [0, 1, 2, 7]) {
      for (const key of keys) {
        expect(i18n.t(key, { count }), `${key} count=${count}`).not.toBe(key)
      }
    }
  })
})
