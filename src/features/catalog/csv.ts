/**
 * CSV import and export for the catalog.
 *
 * Written by hand rather than pulled from a library because the parsing rules are
 * small and the failure mode matters more than the feature: a seller's first act
 * on Selld is often importing a price list she has kept in Excel for two years, and
 * a silent mis-parse there prices her whole catalog wrong.
 *
 * So the importer reports per-row errors and imports the rest, rather than
 * rejecting the file or — much worse — accepting a row it did not understand.
 *
 * Format is one row per VARIANT, with the product repeated. That is how sellers
 * already keep these lists, and it round-trips with what Shopee and Lazada export.
 */

import { parsePesos, toPesoInputValue, type Centavos } from '@/lib/money'

export const CSV_COLUMNS = [
  'product_name',
  'description',
  'category',
  'status',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'sku',
  'barcode',
  'price',
  'compare_at_price',
  'cost',
  'weight_grams',
  'cod_allowed',
] as const

export type CsvColumn = (typeof CSV_COLUMNS)[number]

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split CSV text into rows of fields.
 *
 * Handles quoted fields, embedded commas, escaped `""` quotes, and CRLF — all of
 * which appear in real Excel exports. Product names routinely contain commas
 * ("Serum, 30ml"), so naive `split(',')` corrupts data rather than failing loudly.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  // Strip a UTF-8 BOM; Excel on Windows writes one and it would otherwise become
  // part of the first header name.
  const input = text.replace(/^\ufeff/, '')

  for (let index = 0; index < input.length; index++) {
    const char = input[index]

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      // Consume CRLF as one break.
      if (char === '\r' && input[index + 1] === '\n') index++
      row.push(field)
      field = ''
      // Skip rows that are entirely empty — trailing newlines are universal.
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  row.push(field)
  if (row.some((value) => value.trim() !== '')) rows.push(row)

  return rows
}

export interface CsvVariantRow {
  productName: string
  description: string
  category: string
  status: 'draft' | 'active' | 'archived'
  options: { name: string; value: string }[]
  sku: string
  barcode: string
  price: Centavos
  compareAtPrice: Centavos | null
  cost: Centavos | null
  weightGrams: number | null
  codAllowed: boolean
}

export interface CsvRowError {
  /** 1-based line number in the file, counting the header. */
  line: number
  column: string
  message: string
}

export interface CsvImportResult {
  rows: CsvVariantRow[]
  errors: CsvRowError[]
  /** Header names present in the file that we do not recognise. */
  unknownColumns: string[]
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Parse a catalog CSV into variant rows.
 *
 * Column order does not matter and unknown columns are ignored but reported —
 * a Shopee export has thirty columns we do not want, and refusing the file over
 * them would be useless to the seller.
 */
export function importCatalogCsv(text: string): CsvImportResult {
  const table = parseCsv(text)
  const errors: CsvRowError[] = []

  if (table.length === 0) {
    return { rows: [], errors: [{ line: 1, column: '', message: 'The file is empty.' }], unknownColumns: [] }
  }

  const header = (table[0] ?? []).map(normalizeHeader)
  const index = new Map(header.map((name, position) => [name, position]))
  const unknownColumns = header.filter(
    (name) => name !== '' && !(CSV_COLUMNS as readonly string[]).includes(name),
  )

  if (!index.has('product_name')) {
    return {
      rows: [],
      errors: [{ line: 1, column: 'product_name', message: 'A product_name column is required.' }],
      unknownColumns,
    }
  }

  const rows: CsvVariantRow[] = []

  for (let position = 1; position < table.length; position++) {
    const raw = table[position] ?? []
    const line = position + 1
    const cell = (column: CsvColumn): string => {
      const at = index.get(column)
      return at === undefined ? '' : (raw[at] ?? '').trim()
    }

    const productName = cell('product_name')
    if (productName === '') {
      errors.push({ line, column: 'product_name', message: 'Product name is required.' })
      continue
    }

    const priceText = cell('price')
    const price = parsePesos(priceText === '' ? '0' : priceText)
    if (price === null || price < 0) {
      errors.push({
        line,
        column: 'price',
        message: `"${priceText}" is not a valid price.`,
      })
      continue
    }

    const compareText = cell('compare_at_price')
    let compareAtPrice: Centavos | null = null
    if (compareText !== '') {
      const parsed = parsePesos(compareText)
      if (parsed === null || parsed < 0) {
        errors.push({ line, column: 'compare_at_price', message: `"${compareText}" is not a valid price.` })
        continue
      }
      // The database rejects this too; catching it here names the line.
      if (parsed <= price) {
        errors.push({
          line,
          column: 'compare_at_price',
          message: 'Compare-at price must be higher than the price.',
        })
        continue
      }
      compareAtPrice = parsed
    }

    const costText = cell('cost')
    let cost: Centavos | null = null
    if (costText !== '') {
      const parsed = parsePesos(costText)
      if (parsed === null || parsed < 0) {
        errors.push({ line, column: 'cost', message: `"${costText}" is not a valid cost.` })
        continue
      }
      cost = parsed
    }

    const weightText = cell('weight_grams')
    let weightGrams: number | null = null
    if (weightText !== '') {
      const parsed = Number(weightText)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        errors.push({ line, column: 'weight_grams', message: `"${weightText}" is not a whole number of grams.` })
        continue
      }
      weightGrams = parsed
    }

    const statusText = cell('status').toLowerCase()
    const status: CsvVariantRow['status'] =
      statusText === 'active' || statusText === 'archived' ? statusText : 'draft'
    if (statusText !== '' && statusText !== 'draft' && status === 'draft') {
      errors.push({
        line,
        column: 'status',
        message: `Unknown status "${statusText}". Using draft.`,
      })
      // Not fatal — importing as a draft is safe and recoverable.
    }

    const options: { name: string; value: string }[] = []
    for (const slot of [1, 2, 3] as const) {
      const name = cell(`option${slot}_name` as CsvColumn)
      const value = cell(`option${slot}_value` as CsvColumn)
      if (name === '' && value === '') continue
      if (name === '' || value === '') {
        errors.push({
          line,
          column: `option${slot}`,
          message: 'An option needs both a name and a value.',
        })
        continue
      }
      options.push({ name, value })
    }

    rows.push({
      productName,
      description: cell('description'),
      category: cell('category'),
      status,
      options,
      sku: cell('sku'),
      barcode: cell('barcode'),
      price,
      compareAtPrice,
      cost,
      weightGrams,
      codAllowed: parseBoolean(cell('cod_allowed'), true),
    })
  }

  return { rows, errors, unknownColumns }
}

/** Accepts what sellers actually type for yes/no in a spreadsheet. */
export function parseBoolean(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return fallback
  if (['1', 'true', 'yes', 'y', 'oo', 'opo'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'hindi', 'wala'].includes(normalized)) return false
  return fallback
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface GroupedCsvProduct {
  name: string
  description: string
  category: string
  status: 'draft' | 'active' | 'archived'
  codAllowed: boolean
  optionNames: string[]
  variants: {
    values: string[]
    sku: string
    barcode: string
    price: Centavos
    compareAtPrice: Centavos | null
    cost: Centavos | null
    weightGrams: number | null
  }[]
}

/**
 * Collapse variant rows into products.
 *
 * Rows for one product may be non-adjacent in the file, and a later row may name
 * an option the first did not — so option names are unioned across the group and
 * every variant is padded to that shape. Without the padding, an import where row
 * 1 has no Colour and row 2 does would produce variants of differing arity, which
 * the database rejects wholesale.
 */
export function groupCsvRows(rows: readonly CsvVariantRow[]): GroupedCsvProduct[] {
  interface Pending {
    product: GroupedCsvProduct
    /** Each variant with the options as written on its own row. */
    raw: { options: { name: string; value: string }[]; variant: GroupedCsvProduct['variants'][number] }[]
  }

  const byName = new Map<string, Pending>()

  for (const row of rows) {
    const key = row.productName.trim().toLowerCase()
    let pending = byName.get(key)

    if (!pending) {
      pending = {
        product: {
          name: row.productName,
          description: row.description,
          category: row.category,
          status: row.status,
          codAllowed: row.codAllowed,
          optionNames: [],
          variants: [],
        },
        raw: [],
      }
      byName.set(key, pending)
    }

    for (const option of row.options) {
      const known = pending.product.optionNames.some(
        (name) => name.toLowerCase() === option.name.toLowerCase(),
      )
      if (!known) pending.product.optionNames.push(option.name)
    }

    pending.raw.push({
      options: row.options,
      variant: {
        // Filled in by the alignment pass below.
        values: [],
        sku: row.sku,
        barcode: row.barcode,
        price: row.price,
        compareAtPrice: row.compareAtPrice,
        cost: row.cost,
        weightGrams: row.weightGrams,
      },
    })
  }

  // Align every variant to the product's full option list. A file where row 1 has
  // no Colour and row 2 does would otherwise produce variants of differing arity,
  // which the database rejects for the whole product.
  const result: GroupedCsvProduct[] = []
  for (const { product, raw } of byName.values()) {
    product.variants = raw.map(({ options, variant }) => ({
      ...variant,
      values: product.optionNames.map((name) => {
        const match = options.find((option) => option.name.toLowerCase() === name.toLowerCase())
        return match?.value ?? MISSING_OPTION_VALUE
      }),
    }))
    result.push(product)
  }

  return result
}

/** Placeholder for a variant that did not name one of the product's options. */
export const MISSING_OPTION_VALUE = '—'

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function escapeCsvField(value: string): string {
  // Quote when the value contains a delimiter, a quote, or a line break.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export interface ExportableVariant {
  productName: string
  description: string | null
  category: string | null
  status: string
  codAllowed: boolean
  options: { name: string; value: string }[]
  sku: string | null
  barcode: string | null
  price: Centavos
  compareAtPrice: Centavos | null
  cost: Centavos | null
  weightGrams: number | null
}

/**
 * Render variants as CSV, in exactly the shape {@link importCatalogCsv} accepts,
 * so export → edit in Excel → re-import is lossless.
 */
export function exportCatalogCsv(variants: readonly ExportableVariant[]): string {
  const lines = [CSV_COLUMNS.join(',')]

  for (const variant of variants) {
    const option = (slot: number) => variant.options[slot] ?? { name: '', value: '' }
    const fields: string[] = [
      variant.productName,
      variant.description ?? '',
      variant.category ?? '',
      variant.status,
      option(0).name,
      option(0).value,
      option(1).name,
      option(1).value,
      option(2).name,
      option(2).value,
      variant.sku ?? '',
      variant.barcode ?? '',
      toPesoInputValue(variant.price),
      variant.compareAtPrice === null ? '' : toPesoInputValue(variant.compareAtPrice),
      variant.cost === null ? '' : toPesoInputValue(variant.cost),
      variant.weightGrams === null ? '' : String(variant.weightGrams),
      variant.codAllowed ? 'yes' : 'no',
    ]
    lines.push(fields.map(escapeCsvField).join(','))
  }

  // CRLF: Excel is the destination and it is the format Excel expects.
  return lines.join('\r\n')
}

/** A blank file with just the headers, for sellers starting from scratch. */
export function csvTemplate(): string {
  return [
    CSV_COLUMNS.join(','),
    'Whitening Soap,Kojic acid soap 135g,Skincare,active,Size,135g,,,,,RF-SOAP-135,,149,199,90,150,yes',
    'Whitening Soap,Kojic acid soap 135g,Skincare,active,Size,65g,,,,,RF-SOAP-65,,89,,55,80,yes',
  ].join('\r\n')
}
