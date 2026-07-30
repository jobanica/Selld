import { describe, expect, it } from 'vitest'

import { pesos, type Centavos } from '@/lib/money'

import {
  buildSku,
  combinationKey,
  combinationLabel,
  countCombinations,
  diffVariants,
  generateVariantMatrix,
  MAX_VARIANTS,
  normalizeOptions,
  VariantMatrixError,
  type DraftOption,
  type DraftVariant,
} from './variant-matrix'

const SIZE: DraftOption = { name: 'Size', values: [{ value: 'S' }, { value: 'M' }, { value: 'L' }] }
const COLOR: DraftOption = { name: 'Color', values: [{ value: 'Black' }, { value: 'White' }] }
const SLEEVE: DraftOption = { name: 'Sleeve', values: [{ value: 'Short' }, { value: 'Long' }] }

describe('normalizeOptions()', () => {
  it('trims and drops blanks', () => {
    const result = normalizeOptions([
      { name: '  Size  ', values: [{ value: ' S ' }, { value: '' }, { value: '  ' }] },
    ])
    expect(result).toEqual([{ name: 'Size', values: [{ value: 'S' }] }])
  })

  it('drops an option with no usable values', () => {
    expect(normalizeOptions([{ name: 'Size', values: [{ value: '  ' }] }])).toEqual([])
  })

  it('drops an unnamed option', () => {
    expect(normalizeOptions([{ name: '   ', values: [{ value: 'S' }] }])).toEqual([])
  })

  it('collapses case-duplicate values — a pasted list hits this constantly', () => {
    const result = normalizeOptions([
      { name: 'Color', values: [{ value: 'Black' }, { value: 'black' }, { value: 'BLACK' }] },
    ])
    expect(result[0]!.values).toEqual([{ value: 'Black' }])
  })

  it('rejects two options with the same name', () => {
    expect(() =>
      normalizeOptions([
        { name: 'Size', values: [{ value: 'S' }] },
        { name: 'size', values: [{ value: 'M' }] },
      ]),
    ).toThrow(VariantMatrixError)
  })

  it('preserves ids on already-persisted options and values', () => {
    const result = normalizeOptions([
      { id: 'opt-1', name: 'Size', values: [{ id: 'val-1', value: 'S' }] },
    ])
    expect(result).toEqual([{ id: 'opt-1', name: 'Size', values: [{ id: 'val-1', value: 'S' }] }])
  })
})

describe('countCombinations()', () => {
  it('multiplies out', () => {
    expect(countCombinations([SIZE])).toBe(3)
    expect(countCombinations([SIZE, COLOR])).toBe(6)
    expect(countCombinations([SIZE, COLOR, SLEEVE])).toBe(12)
  })

  it('is 1 for no options — a product still has one sellable variant', () => {
    expect(countCombinations([])).toBe(1)
  })
})

describe('generateVariantMatrix()', () => {
  it("hits the phase-3 target: 3 options -> 12 variants", () => {
    const variants = generateVariantMatrix([SIZE, COLOR, SLEEVE])
    expect(variants).toHaveLength(12)
    expect(new Set(variants.map((v) => combinationKey(v.values))).size).toBe(12)
  })

  it('varies the LAST option fastest, so rows group by size like a rack', () => {
    const variants = generateVariantMatrix([SIZE, COLOR])
    expect(variants.map((v) => combinationLabel(v.values))).toEqual([
      'S / Black',
      'S / White',
      'M / Black',
      'M / White',
      'L / Black',
      'L / White',
    ])
  })

  it('produces one valueless variant when there are no options', () => {
    const variants = generateVariantMatrix([])
    expect(variants).toHaveLength(1)
    expect(variants[0]!.values).toEqual([])
  })

  it('applies the default price to every new row', () => {
    const variants = generateVariantMatrix([SIZE], { defaultPrice: pesos('499') })
    expect(variants.every((v) => v.price === 49900)).toBe(true)
  })

  it('refuses a matrix large enough to be a mistake', () => {
    const huge: DraftOption[] = [
      { name: 'A', values: Array.from({ length: 15 }, (_, i) => ({ value: `a${i}` })) },
      { name: 'B', values: Array.from({ length: 15 }, (_, i) => ({ value: `b${i}` })) },
    ]
    expect(countCombinations(huge)).toBe(225)
    expect(() => generateVariantMatrix(huge)).toThrow(/exceeds the limit/)
    try {
      generateVariantMatrix(huge)
    } catch (error) {
      expect((error as VariantMatrixError).reason).toBe('too_many')
    }
  })

  it('allows exactly the maximum', () => {
    const atLimit: DraftOption[] = [
      { name: 'A', values: Array.from({ length: MAX_VARIANTS }, (_, i) => ({ value: `a${i}` })) },
    ]
    expect(generateVariantMatrix(atLimit)).toHaveLength(MAX_VARIANTS)
  })

  /**
   * The behaviour that makes the feature usable: adding a colour to a product
   * whose twelve prices are already typed must not blank those prices.
   */
  it('KEEPS prices and SKUs for combinations that already existed', () => {
    const first = generateVariantMatrix([SIZE, COLOR], { defaultPrice: pesos('499') })
    // The seller edits two rows.
    const edited = first.map((variant, index) =>
      index === 0
        ? { ...variant, price: pesos('599'), sku: 'RF-S-BLACK', id: 'v0' }
        : index === 1
          ? { ...variant, price: pesos('549'), id: 'v1' }
          : { ...variant, id: `v${index}` },
    )

    // Then adds a third option.
    const second = generateVariantMatrix([SIZE, COLOR, SLEEVE], {
      defaultPrice: pesos('499'),
      existing: edited,
    })

    expect(second).toHaveLength(12)
    // The old 2-option combinations no longer exist as such, so nothing is kept —
    // which is correct: "S/Black" is not the same variant as "S/Black/Short".
    expect(second.every((v) => v.values.length === 3)).toBe(true)

    // But regenerating the SAME options keeps every edit.
    const again = generateVariantMatrix([SIZE, COLOR], {
      defaultPrice: pesos('499'),
      existing: edited,
    })
    expect(again[0]!.price).toBe(59900)
    expect(again[0]!.sku).toBe('RF-S-BLACK')
    expect(again[0]!.id).toBe('v0')
    expect(again[1]!.price).toBe(54900)
  })

  it('keeps edits when a value is added to an existing option', () => {
    const before = generateVariantMatrix([COLOR], { defaultPrice: pesos('100') }).map((v, i) => ({
      ...v,
      id: `v${i}`,
      price: pesos('250'),
    }))

    const after = generateVariantMatrix(
      [{ name: 'Color', values: [...COLOR.values, { value: 'Red' }] }],
      { defaultPrice: pesos('100'), existing: before },
    )

    expect(after).toHaveLength(3)
    // Black and White keep ₱250; the new Red gets the default.
    expect(after.find((v) => v.values[0] === 'Black')!.price).toBe(25000)
    expect(after.find((v) => v.values[0] === 'White')!.price).toBe(25000)
    expect(after.find((v) => v.values[0] === 'Red')!.price).toBe(10000)
  })

  it('auto-generates SKUs from a prefix when asked', () => {
    const variants = generateVariantMatrix([SIZE, COLOR], { skuPrefix: 'RF-TEE' })
    expect(variants[0]!.sku).toBe('RF-TEE-S-BLACK')
    expect(variants[5]!.sku).toBe('RF-TEE-L-WHITE')
    expect(new Set(variants.map((v) => v.sku)).size).toBe(variants.length)
  })

  it('leaves SKUs blank when no prefix is given', () => {
    expect(generateVariantMatrix([SIZE])[0]!.sku).toBe('')
  })
})

describe('buildSku()', () => {
  it('uppercases and strips punctuation', () => {
    expect(buildSku('rf-tee', ['S', 'Black'], 0)).toBe('RF-TEE-S-BLACK')
    expect(buildSku('RF TEE!', ['X-Large'], 0)).toBe('RFTEE-XLARGE')
  })

  it('truncates long values so a SKU stays scannable', () => {
    expect(buildSku('RF', ['Extraordinarily Long Colour'], 0)).toBe('RF-EXTRAORD')
  })

  it('falls back to a position when values yield no characters', () => {
    expect(buildSku('RF', ['💚'], 4)).toBe('RF-5')
  })
})

describe('diffVariants()', () => {
  const stored: DraftVariant[] = [
    {
      id: 'v1',
      values: ['S', 'Black'],
      sku: 'A',
      price: pesos('100'),
      compareAtPrice: null,
      cost: null,
      weightGrams: null,
    },
    {
      id: 'v2',
      values: ['M', 'Black'],
      sku: 'B',
      price: pesos('200'),
      compareAtPrice: null,
      cost: null,
      weightGrams: null,
    },
  ]

  it('reports nothing when nothing changed', () => {
    expect(diffVariants(stored, stored)).toEqual({ created: [], updated: [], deletedIds: [] })
  })

  it('detects a created combination', () => {
    const next = [
      ...stored,
      {
        values: ['L', 'Black'],
        sku: 'C',
        price: pesos('300') as Centavos,
        compareAtPrice: null,
        cost: null,
        weightGrams: null,
      },
    ]
    const diff = diffVariants(next, stored)
    expect(diff.created).toHaveLength(1)
    expect(diff.created[0]!.values).toEqual(['L', 'Black'])
    expect(diff.deletedIds).toEqual([])
  })

  it('detects a removed combination and reports its id for deletion', () => {
    const diff = diffVariants([stored[0]!], stored)
    expect(diff.deletedIds).toEqual(['v2'])
    expect(diff.created).toEqual([])
  })

  it('detects an edited row and carries the stored id forward', () => {
    const next = [{ ...stored[0]!, price: pesos('150') }, stored[1]!]
    const diff = diffVariants(next, stored)
    expect(diff.updated).toHaveLength(1)
    expect(diff.updated[0]!.id).toBe('v1')
    expect(diff.updated[0]!.price).toBe(15000)
  })

  /**
   * A variant carries inventory (phase 4) and is referenced by order items
   * (phase 6). Reporting an unchanged row as deleted-and-recreated would silently
   * discard its stock, so an untouched combination must never appear in the diff.
   */
  it('never deletes and recreates an untouched combination', () => {
    const regenerated = generateVariantMatrix(
      [
        { name: 'Size', values: [{ value: 'S' }, { value: 'M' }] },
        { name: 'Color', values: [{ value: 'Black' }] },
      ],
      { existing: stored },
    )
    const diff = diffVariants(regenerated, stored)
    expect(diff.created).toEqual([])
    expect(diff.updated).toEqual([])
    expect(diff.deletedIds).toEqual([])
  })

  it('ignores whitespace-only SKU changes', () => {
    const next = [{ ...stored[0]!, sku: '  A  ' }, stored[1]!]
    expect(diffVariants(next, stored).updated).toEqual([])
  })
})
