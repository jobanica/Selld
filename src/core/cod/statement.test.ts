import { describe, expect, it } from 'vitest'

import { pesos } from '@/lib/money'

import {
  parseCsv,
  parseMoneyCentavos,
  parseStatementDate,
  parseStatementFile,
  parseStatementSheet,
  StatementError,
  toImportPayload,
} from './statement'
import { readXlsx } from './xlsx'

/**
 * These fixtures are shaped like the files couriers actually hand a seller, not
 * like a tidy table. Two rows of branding above the header, a peso sign in the
 * money, a thousands separator, a footer total, and column names that differ per
 * courier — every one of those is a real thing that broke a naive parse.
 */

/** J&T: branding rows, `Waybill No.`, peso signs, a footer total. */
const JNT_CSV = `J&T EXPRESS PHILIPPINES
COD Remittance Report,,,
Period,2026-07-01 to 2026-07-15,,
,,,
Waybill No.,COD Amount,Service Fee,Remitted Date
JT2607310001,"₱1,450.00",₱0.00,15/07/2026
JT2607310002,"₱378.00",₱0.00,15/07/2026
JT2607310003,"₱12,999.50",₱0.00,15/07/2026
,,,
TOTAL,"₱14,827.50",,
`

/** Flash: no branding, different column names, a fee column that is not zero. */
const FLASH_CSV = `Tracking No,COD Value,Handling Fee,Settlement Date
FL00099001,1450.00,25.00,2026-07-15
FL00099002,378.00,25.00,2026-07-15
`

describe('parseMoneyCentavos', () => {
  it('reads the shapes couriers actually write', () => {
    expect(parseMoneyCentavos('1450')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('1,450.00')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('₱1,450.00')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('PHP 1450.50')).toBe(pesos('1450.50'))
    expect(parseMoneyCentavos(' 12,999.50 ')).toBe(pesos('12999.50'))
  })

  it('gets the thousands separator right in both conventions', () => {
    // The decimal separator is whichever appears *last*. Anything else reads
    // `1,450` as one peso and fifty centavos — a 99.9% under-count that would
    // look like the courier stole almost everything.
    expect(parseMoneyCentavos('1,450')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('1.450,00')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('1 450,00')).toBe(pesos('1450'))
    expect(parseMoneyCentavos('1,234,567.89')).toBe(pesos('1234567.89'))
  })

  it('never goes through a float', () => {
    // 0.29 * 100 is 28.999999999999996 and 1024.09 * 100 is 102408.99999999999.
    // Both are exact here because the parse is integer arithmetic end to end.
    expect(parseMoneyCentavos('0.29')).toBe(29)
    expect(parseMoneyCentavos('1024.09')).toBe(102409)
    expect(parseMoneyCentavos('8000.07')).toBe(800007)
  })

  it('reads an accounting negative', () => {
    expect(parseMoneyCentavos('(120.50)')).toBe(pesos('-120.50'))
    expect(parseMoneyCentavos('-120.50')).toBe(pesos('-120.50'))
  })

  it('returns null rather than zero for something it cannot read', () => {
    // Zero is a claim: "the courier deducted nothing". A fee cell reading "N/A"
    // must not make that claim on the courier's behalf.
    expect(parseMoneyCentavos('')).toBeNull()
    expect(parseMoneyCentavos('N/A')).toBeNull()
    expect(parseMoneyCentavos('-')).toBeNull()
  })
})

describe('parseStatementDate', () => {
  it('reads what couriers emit', () => {
    expect(parseStatementDate('2026-07-15')).toBe('2026-07-15')
    expect(parseStatementDate('15/07/2026')).toBe('2026-07-15')
    expect(parseStatementDate('15-Jul-2026')).toBe('2026-07-15')
  })

  it('resolves an ambiguous d/m as day-first, which is what PH portals emit', () => {
    expect(parseStatementDate('07/03/2026')).toBe('2026-03-07')
    // A "month" over 12 can only be a day, so an mm/dd file reads correctly too.
    expect(parseStatementDate('07/31/2026')).toBe('2026-07-31')
  })

  it('converts an Excel serial', () => {
    // 46218 is 2026-07-15. The epoch is 1899-12-30, not the 31st, because Lotus
    // thought 1900 was a leap year and Excel kept the bug for compatibility.
    expect(parseStatementDate('46218')).toBe('2026-07-15')
  })

  it('returns null for a header that slipped into the data', () => {
    expect(parseStatementDate('Remitted Date')).toBeNull()
    expect(parseStatementDate('')).toBeNull()
  })
})

describe('parseCsv', () => {
  it('handles quotes, embedded commas and CRLF', () => {
    const rows = parseCsv('a,b\r\n"1,450","say ""hi"""\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1,450', 'say "hi"'],
    ])
  })

  it('strips the BOM Excel writes', () => {
    // Without this the first header carries an invisible U+FEFF, matches no
    // alias, and a J&T file reports "no waybill column" on a file that has one.
    const rows = parseCsv('\uFEFFWaybill No.,COD Amount\nJT1,100\n')
    expect(rows[0]?.[0]).toBe('Waybill No.')
  })

  it('detects a semicolon delimiter', () => {
    expect(parseCsv('a;b\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('parseStatementSheet', () => {
  it('finds the header under the courier’s branding rows', () => {
    const statement = parseStatementSheet(parseCsv(JNT_CSV), 'jnt')
    expect(statement.columns.waybill).toBe('Waybill No.')
    expect(statement.columns.amount).toBe('COD Amount')
    expect(statement.lines).toHaveLength(3)
  })

  it('reads the amounts as centavos', () => {
    const statement = parseStatementSheet(parseCsv(JNT_CSV), 'jnt')
    expect(statement.lines.map((line) => line.amount)).toEqual([
      pesos('1450'),
      pesos('378'),
      pesos('12999.50'),
    ])
    expect(statement.lines[0]?.remittedAt).toBe('2026-07-15')
  })

  it('keeps the statement’s own declared total', () => {
    // Worth having precisely so it can be disagreed with: a footer that does not
    // match the lines means the file is internally inconsistent, and that is a
    // finding before any individual parcel is.
    const statement = parseStatementSheet(parseCsv(JNT_CSV), 'jnt')
    expect(statement.declaredTotal).toBe(pesos('14827.50'))
    const summed = statement.lines.reduce((total, line) => total + line.amount, 0)
    expect(summed).toBe(pesos('14827.50'))
  })

  it('reads a different courier’s column names without configuration', () => {
    const statement = parseStatementSheet(parseCsv(FLASH_CSV), 'flash')
    expect(statement.columns.waybill).toBe('Tracking No')
    expect(statement.columns.amount).toBe('COD Value')
    expect(statement.columns.fee).toBe('Handling Fee')
    expect(statement.lines[0]?.fee).toBe(pesos('25'))
  })

  it('does not mistake the fee column for the amount', () => {
    // "COD Fee" contains "cod". Matching the amount first would read the
    // courier's cut as the whole payout, and every line would post a variance of
    // the entire order value.
    const sheet = parseCsv('Waybill No.,COD Fee,COD Amount\nJT1,25.00,1450.00\n')
    const statement = parseStatementSheet(sheet, 'jnt')
    expect(statement.columns.amount).toBe('COD Amount')
    expect(statement.lines[0]?.amount).toBe(pesos('1450'))
    expect(statement.lines[0]?.fee).toBe(pesos('25'))
  })

  it('normalises the waybill the way the database matches it', () => {
    const sheet = parseCsv('Waybill No.,COD Amount\n" jt260731000a ",100\n')
    expect(parseStatementSheet(sheet, 'jnt').lines[0]?.waybill).toBe('JT260731000A')
  })

  it('reports rows it could not use instead of dropping them silently', () => {
    const sheet = parseCsv('Waybill No.,COD Amount\nJT1,100\nJT2,N/A\n')
    const statement = parseStatementSheet(sheet, 'jnt')
    expect(statement.lines).toHaveLength(1)
    expect(statement.skipped).toEqual([
      { row: 3, reason: 'no_amount', cells: ['JT2', 'N/A'] },
    ])
  })

  it('refuses a file that is not a statement, with a reason', () => {
    expect(() => parseStatementSheet(parseCsv('name,qty\nSoap,3\n'), 'jnt')).toThrow(StatementError)
    try {
      parseStatementSheet(parseCsv('name,qty\nSoap,3\n'), 'jnt')
    } catch (error) {
      expect((error as StatementError).code).toBe('no_header')
    }
  })

  it('says which half is missing when only one column is recognisable', () => {
    try {
      parseStatementSheet(parseCsv('Waybill No.,Status\nJT1,Delivered\n'), 'jnt')
    } catch (error) {
      expect((error as StatementError).code).toBe('no_amount_column')
    }
  })
})

describe('toImportPayload', () => {
  it('hands the database plain integers', () => {
    const payload = toImportPayload(parseStatementSheet(parseCsv(FLASH_CSV), 'flash'))
    expect(payload[0]).toEqual({
      waybill: 'FL00099001',
      amount: 145000,
      fee: 2500,
      remittedAt: '2026-07-15',
      raw: {
        'Tracking No': 'FL00099001',
        'COD Value': '1450.00',
        'Handling Fee': '25.00',
        'Settlement Date': '2026-07-15',
      },
    })
  })
})

describe('parseStatementFile', () => {
  it('sniffs the format from the bytes, not the filename', async () => {
    // A `.csv` that is really an `.xlsx` happens whenever a seller picks the
    // wrong entry in Excel's "save as". Trusting the extension would read the
    // ZIP as one long line of binary and report an empty file.
    const csv = new TextEncoder().encode(FLASH_CSV)
    const statement = await parseStatementFile(csv, 'flash', readXlsx)
    expect(statement.lines).toHaveLength(2)
  })
})
