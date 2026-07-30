import { describe, expect, it } from 'vitest'

import { pesos } from '@/lib/money'

import {
  csvTemplate,
  exportCatalogCsv,
  groupCsvRows,
  importCatalogCsv,
  MISSING_OPTION_VALUE,
  parseBoolean,
  parseCsv,
  type ExportableVariant,
} from './csv'

describe('parseCsv()', () => {
  it('parses a simple table', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  /**
   * The case that corrupts data silently with `split(',')`. PH product names are
   * full of commas: "Serum, 30ml", "Soap, 3 pcs".
   */
  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('name,price\n"Serum, 30ml",499')).toEqual([
      ['name', 'price'],
      ['Serum, 30ml', '499'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('name\n"Rhea""s Soap"')).toEqual([['name'], ['Rhea"s Soap']])
  })

  it('handles CRLF, which is what Excel writes', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('strips the UTF-8 BOM Excel on Windows prepends', () => {
    // Left in place, the BOM becomes part of the first header name and the
    // product_name column stops being found.
    expect(parseCsv('\ufeffproduct_name\nSoap')[0]).toEqual(['product_name'])
  })

  it('skips blank lines rather than emitting empty rows', () => {
    expect(parseCsv('a\n\n1\n\n')).toEqual([['a'], ['1']])
  })

  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('name,desc\n"Soap","Line 1\nLine 2"')).toEqual([
      ['name', 'desc'],
      ['Soap', 'Line 1\nLine 2'],
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\n')).toEqual([])
  })
})

describe('importCatalogCsv()', () => {
  it('imports a two-variant product', () => {
    const csv = [
      'product_name,option1_name,option1_value,sku,price,cost',
      'Whitening Soap,Size,135g,RF-135,149,90',
      'Whitening Soap,Size,65g,RF-65,89,55',
    ].join('\n')

    const result = importCatalogCsv(csv)
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      productName: 'Whitening Soap',
      sku: 'RF-135',
      price: 14900,
      cost: 9000,
      options: [{ name: 'Size', value: '135g' }],
    })
  })

  it('does not care about column order', () => {
    const result = importCatalogCsv('price,product_name\n149,Soap')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ productName: 'Soap', price: 14900 })
  })

  it('reports unknown columns but still imports — a Shopee export has dozens', () => {
    const result = importCatalogCsv(
      'product_name,price,shopee_item_id,promo_flag\nSoap,149,12345,Y',
    )
    expect(result.rows).toHaveLength(1)
    expect(result.unknownColumns).toEqual(['shopee_item_id', 'promo_flag'])
  })

  it('accepts header names written with spaces or hyphens', () => {
    const result = importCatalogCsv('Product Name,Compare-At Price,Price\nSoap,199,149')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ price: 14900, compareAtPrice: 19900 })
  })

  /**
   * The core promise: one bad row must not cost the seller the other 200.
   */
  it('imports the good rows and reports the bad ones by line number', () => {
    const csv = [
      'product_name,price',
      'Soap,149', // ok
      ',199', // missing name
      'Serum,abc', // unparseable price
      'Toner,299', // ok
    ].join('\n')

    const result = importCatalogCsv(csv)
    expect(result.rows.map((row) => row.productName)).toEqual(['Soap', 'Toner'])
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toMatchObject({ line: 3, column: 'product_name' })
    expect(result.errors[1]).toMatchObject({ line: 4, column: 'price' })
  })

  it('rejects a price with more than two decimals rather than rounding it', () => {
    const result = importCatalogCsv('product_name,price\nSoap,149.999')
    expect(result.rows).toEqual([])
    expect(result.errors[0]!.column).toBe('price')
  })

  it('rejects a compare-at price that is not above the price', () => {
    const result = importCatalogCsv('product_name,price,compare_at_price\nSoap,149,149')
    expect(result.rows).toEqual([])
    expect(result.errors[0]).toMatchObject({ column: 'compare_at_price' })
  })

  it('treats a missing price as zero, not as an error', () => {
    const result = importCatalogCsv('product_name,price\nSoap,')
    expect(result.errors).toEqual([])
    expect(result.rows[0]!.price).toBe(0)
  })

  it('rejects a fractional weight', () => {
    const result = importCatalogCsv('product_name,price,weight_grams\nSoap,149,12.5')
    expect(result.errors[0]!.column).toBe('weight_grams')
  })

  it('requires both a name and a value for an option', () => {
    const result = importCatalogCsv('product_name,price,option1_name,option1_value\nSoap,149,Size,')
    expect(result.errors[0]!.column).toBe('option1')
    expect(result.rows[0]!.options).toEqual([])
  })

  it('defaults an unknown status to draft and says so', () => {
    const result = importCatalogCsv('product_name,price,status\nSoap,149,LIVE')
    expect(result.rows[0]!.status).toBe('draft')
    expect(result.errors[0]!.column).toBe('status')
  })

  it('requires a product_name column', () => {
    const result = importCatalogCsv('name,price\nSoap,149')
    expect(result.rows).toEqual([])
    expect(result.errors[0]!.column).toBe('product_name')
  })

  it('reports an empty file', () => {
    expect(importCatalogCsv('').errors).toHaveLength(1)
  })

  it('round-trips the shipped template', () => {
    const result = importCatalogCsv(csvTemplate())
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(2)
  })
})

describe('parseBoolean()', () => {
  it('accepts what sellers actually type, including Taglish', () => {
    for (const yes of ['1', 'true', 'YES', 'y', 'Oo', 'opo']) {
      expect(parseBoolean(yes, false), yes).toBe(true)
    }
    for (const no of ['0', 'false', 'NO', 'n', 'Hindi', 'wala']) {
      expect(parseBoolean(no, true), no).toBe(false)
    }
  })

  it('falls back for blank or unrecognised input', () => {
    expect(parseBoolean('', true)).toBe(true)
    expect(parseBoolean('maybe', false)).toBe(false)
  })
})

describe('groupCsvRows()', () => {
  it('collapses variant rows into one product', () => {
    const { rows } = importCatalogCsv(
      [
        'product_name,option1_name,option1_value,option2_name,option2_value,price',
        'Tee,Size,S,Color,Black,499',
        'Tee,Size,S,Color,White,499',
        'Tee,Size,M,Color,Black,499',
      ].join('\n'),
    )
    const products = groupCsvRows(rows)
    expect(products).toHaveLength(1)
    expect(products[0]!.optionNames).toEqual(['Size', 'Color'])
    expect(products[0]!.variants.map((v) => v.values)).toEqual([
      ['S', 'Black'],
      ['S', 'White'],
      ['M', 'Black'],
    ])
  })

  it('groups rows for one product even when they are not adjacent', () => {
    const { rows } = importCatalogCsv(
      [
        'product_name,option1_name,option1_value,price',
        'Tee,Size,S,499',
        'Cap,Size,One,299',
        'Tee,Size,M,499',
      ].join('\n'),
    )
    const products = groupCsvRows(rows)
    expect(products.map((p) => p.name)).toEqual(['Tee', 'Cap'])
    expect(products[0]!.variants).toHaveLength(2)
  })

  it('matches product names case-insensitively', () => {
    const { rows } = importCatalogCsv('product_name,price\nSoap,149\nsoap,149')
    expect(groupCsvRows(rows)).toHaveLength(1)
  })

  /**
   * The alignment case. If row 1 omits Colour and row 2 names it, the variants
   * would otherwise have different numbers of values — which the database rejects
   * for the whole product, not just the odd row.
   */
  it('pads variants to the union of option names across the group', () => {
    const { rows } = importCatalogCsv(
      [
        'product_name,option1_name,option1_value,option2_name,option2_value,price',
        'Tee,Size,S,,,499',
        'Tee,Size,M,Color,Black,499',
      ].join('\n'),
    )
    const products = groupCsvRows(rows)
    expect(products[0]!.optionNames).toEqual(['Size', 'Color'])
    // Every variant has one value per option.
    expect(products[0]!.variants.map((v) => v.values.length)).toEqual([2, 2])
    expect(products[0]!.variants[0]!.values).toEqual(['S', MISSING_OPTION_VALUE])
  })

  it('handles a product with no options at all', () => {
    const { rows } = importCatalogCsv('product_name,price\nSoap,149')
    const products = groupCsvRows(rows)
    expect(products[0]!.optionNames).toEqual([])
    expect(products[0]!.variants[0]!.values).toEqual([])
  })
})

describe('exportCatalogCsv()', () => {
  const variant: ExportableVariant = {
    productName: 'Serum, 30ml',
    description: 'Niacinamide 10%',
    category: 'Skincare',
    status: 'active',
    codAllowed: true,
    options: [{ name: 'Size', value: '30ml' }],
    sku: 'RF-SER-30',
    barcode: null,
    price: pesos('499'),
    compareAtPrice: pesos('699'),
    cost: pesos('220'),
    weightGrams: 120,
  }

  it('quotes a field containing a comma', () => {
    expect(exportCatalogCsv([variant])).toContain('"Serum, 30ml"')
  })

  it('writes money as plain decimals', () => {
    const csv = exportCatalogCsv([variant])
    expect(csv).toContain('499.00')
    expect(csv).toContain('699.00')
    expect(csv).toContain('220.00')
  })

  it('leads with the documented header row', () => {
    expect(exportCatalogCsv([]).split('\r\n')[0]).toContain('product_name')
  })

  /** Export → edit in Excel → re-import must not lose anything. */
  it('round-trips through the importer', () => {
    const csv = exportCatalogCsv([variant])
    const result = importCatalogCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({
      productName: 'Serum, 30ml',
      description: 'Niacinamide 10%',
      category: 'Skincare',
      status: 'active',
      sku: 'RF-SER-30',
      price: 49900,
      compareAtPrice: 69900,
      cost: 22000,
      weightGrams: 120,
      codAllowed: true,
      options: [{ name: 'Size', value: '30ml' }],
    })
  })

  it('round-trips a quote inside a product name', () => {
    const tricky: ExportableVariant = { ...variant, productName: 'Rhea"s "Best" Soap' }
    const result = importCatalogCsv(exportCatalogCsv([tricky]))
    expect(result.rows[0]!.productName).toBe('Rhea"s "Best" Soap')
  })

  it('round-trips cod_allowed = false', () => {
    const result = importCatalogCsv(exportCatalogCsv([{ ...variant, codAllowed: false }]))
    expect(result.rows[0]!.codAllowed).toBe(false)
  })
})
