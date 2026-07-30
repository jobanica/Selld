import { centavos, type Centavos } from '@/lib/money'

/**
 * The variant matrix generator: Size × Colour → variants.
 *
 * This is the piece that makes the phase-3 target reachable — a 3-option product
 * with 12 variants in under 2 minutes on a phone. Typing 12 rows by hand is not
 * that; typing three option lists and having the combinations appear is.
 *
 * Deliberately pure and free of React and Supabase, so the arithmetic can be
 * tested exhaustively and reused by the CSV importer.
 */

export interface DraftOptionValue {
  /** Present once persisted; absent for a value the seller just typed. */
  id?: string
  value: string
}

export interface DraftOption {
  id?: string
  name: string
  values: DraftOptionValue[]
}

export interface DraftVariant {
  /** Present when this variant already exists in the database. */
  id?: string
  /**
   * One value per option, in the same order as the options array.
   *
   * Stored positionally rather than as a map because the seller may not have named
   * the options yet — during quick-add, "S / Black" exists before either option
   * has an id.
   */
  values: string[]
  sku: string
  price: Centavos
  compareAtPrice: Centavos | null
  cost: Centavos | null
  weightGrams: number | null
}

/** Stable key for a combination, used to diff a regenerated matrix against the old one. */
export function combinationKey(values: readonly string[]): string {
  // Unit separator: cannot appear in a value a seller can type, so no escaping.
  return values.join('')
}

/** Human label for a variant row: `S / Black`. */
export function combinationLabel(values: readonly string[]): string {
  return values.join(' / ')
}

export const MAX_VARIANTS = 200

export class VariantMatrixError extends Error {
  readonly reason: 'too_many' | 'duplicate_option' | 'duplicate_value' | 'empty_option'
  constructor(reason: VariantMatrixError['reason'], message: string) {
    super(message)
    this.name = 'VariantMatrixError'
    this.reason = reason
  }
}

/** Trim, drop blanks, and de-duplicate case-insensitively, preserving order. */
export function normalizeOptions(options: readonly DraftOption[]): DraftOption[] {
  const seenNames = new Set<string>()
  const result: DraftOption[] = []

  for (const option of options) {
    const name = option.name.trim()
    if (name === '') continue

    const lower = name.toLowerCase()
    if (seenNames.has(lower)) {
      throw new VariantMatrixError('duplicate_option', `Duplicate option "${name}"`)
    }
    seenNames.add(lower)

    const seenValues = new Set<string>()
    const values: DraftOptionValue[] = []
    for (const candidate of option.values) {
      const value = candidate.value.trim()
      if (value === '') continue
      const valueLower = value.toLowerCase()
      // Silently collapse "Black" and "black" — a seller pasting a list will hit
      // this constantly, and it is never what they meant.
      if (seenValues.has(valueLower)) continue
      seenValues.add(valueLower)
      values.push(candidate.id === undefined ? { value } : { id: candidate.id, value })
    }

    if (values.length === 0) continue
    result.push(option.id === undefined ? { name, values } : { id: option.id, name, values })
  }

  return result
}

/** How many variants a set of options implies, before generating them. */
export function countCombinations(options: readonly DraftOption[]): number {
  const normalized = normalizeOptions(options)
  if (normalized.length === 0) return 1
  return normalized.reduce((total, option) => total * option.values.length, 1)
}

export interface GenerateOptions {
  /** Applied to every newly created row. */
  defaultPrice?: Centavos
  /**
   * Existing variants, matched by combination so a regenerated matrix keeps the
   * prices and SKUs the seller already typed. This is the difference between
   * adding one colour and re-entering twelve prices.
   */
  existing?: readonly DraftVariant[]
  /** Template for auto-generated SKUs, e.g. `RF-TEE`. */
  skuPrefix?: string
}

/**
 * Cartesian product of the option values, in the order sellers expect:
 * the LAST option varies fastest, so `S/Black, S/White, M/Black, M/White` —
 * grouped by size, which is how a rack and a packing shelf are organised.
 */
export function generateVariantMatrix(
  options: readonly DraftOption[],
  { defaultPrice = centavos(0), existing = [], skuPrefix }: GenerateOptions = {},
): DraftVariant[] {
  const normalized = normalizeOptions(options)

  const total = normalized.reduce((count, option) => count * option.values.length, 1)
  if (total > MAX_VARIANTS) {
    throw new VariantMatrixError(
      'too_many',
      `${total} variants exceeds the limit of ${MAX_VARIANTS}. Split this into separate products.`,
    )
  }

  const previous = new Map(existing.map((variant) => [combinationKey(variant.values), variant]))

  // No options: a single default variant carrying the price.
  if (normalized.length === 0) {
    const kept = previous.get(combinationKey([]))
    return [
      kept ?? {
        values: [],
        sku: skuPrefix ?? '',
        price: defaultPrice,
        compareAtPrice: null,
        cost: null,
        weightGrams: null,
      },
    ]
  }

  const combinations: string[][] = [[]]
  for (const option of normalized) {
    const next: string[][] = []
    // Outer loop over accumulated prefixes, inner over this option's values, so
    // later options vary fastest.
    for (const prefix of combinations) {
      for (const value of option.values) {
        next.push([...prefix, value.value])
      }
    }
    combinations.length = 0
    combinations.push(...next)
  }

  return combinations.map((values, index) => {
    const kept = previous.get(combinationKey(values))
    if (kept) return kept
    return {
      values,
      sku: skuPrefix ? buildSku(skuPrefix, values, index) : '',
      price: defaultPrice,
      compareAtPrice: null,
      cost: null,
      weightGrams: null,
    }
  })
}

/**
 * `RF-TEE-S-BLACK`. Falls back to a positional suffix when the values contain no
 * usable characters (e.g. a colour written only in an emoji).
 */
export function buildSku(prefix: string, values: readonly string[], index: number): string {
  const parts = values
    .map((value) =>
      value
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '')
        .slice(0, 8),
    )
    .filter((part) => part !== '')

  const base = prefix.toUpperCase().replace(/[^A-Z0-9-]+/g, '')
  if (parts.length === 0) return `${base}-${index + 1}`
  return [base, ...parts].join('-')
}

/**
 * Diff a regenerated matrix against what is stored, so saving issues the minimum
 * set of writes.
 *
 * Matters more than it looks: regenerating means deleting variants, and a variant
 * carries inventory (phase 4) and is referenced by order items (phase 6). Deleting
 * and recreating a row the seller did not actually change would silently discard
 * its stock.
 */
export interface VariantDiff {
  created: DraftVariant[]
  updated: DraftVariant[]
  deletedIds: string[]
}

export function diffVariants(
  next: readonly DraftVariant[],
  stored: readonly DraftVariant[],
): VariantDiff {
  const storedByKey = new Map(stored.map((variant) => [combinationKey(variant.values), variant]))
  const nextKeys = new Set(next.map((variant) => combinationKey(variant.values)))

  const created: DraftVariant[] = []
  const updated: DraftVariant[] = []

  for (const variant of next) {
    const key = combinationKey(variant.values)
    const before = storedByKey.get(key)
    if (!before) {
      created.push(variant)
    } else if (hasChanged(variant, before)) {
      updated.push(before.id === undefined ? variant : { ...variant, id: before.id })
    }
  }

  const deletedIds = stored
    .filter((variant) => variant.id !== undefined && !nextKeys.has(combinationKey(variant.values)))
    .map((variant) => variant.id as string)

  return { created, updated, deletedIds }
}

function hasChanged(a: DraftVariant, b: DraftVariant): boolean {
  return (
    a.sku.trim() !== b.sku.trim() ||
    a.price !== b.price ||
    a.compareAtPrice !== b.compareAtPrice ||
    a.cost !== b.cost ||
    a.weightGrams !== b.weightGrams
  )
}
