/**
 * Turning a courier's payout spreadsheet into rows Selld can reconcile.
 *
 * ## The problem this solves
 *
 * A COD remittance statement is a seller's bank statement, written by someone else,
 * in a format nobody agreed on. J&T calls the waybill column "Waybill No." and the
 * money "COD Amount"; Flash calls them "Tracking No" and "COD Value"; LBC exports
 * with the columns in a different order and a peso sign in every cell. Some export
 * CSV, some XLSX, most put two rows of branding above the header, and at least one
 * writes amounts as `1,450.00` with a thousands separator that a naive
 * `parseFloat` reads as `1`.
 *
 * So: find the header row wherever it is, recognise the columns by what they are
 * called rather than by position, and parse money as centavos through
 * `src/lib/money` — never `parseFloat`, per hard rule 2.
 *
 * ## What this module does not decide
 *
 * Nothing here says whether a line is *matched*. That happens in
 * `cod_import_statement()` against the seller's own shipments, because a client
 * that could assert "matched" could assert that an unpaid order was paid. This
 * module's entire job is: these are the numbers the courier wrote down.
 */

import { centavos, type Centavos } from '@/lib/money'

import type { Sheet } from './xlsx'

export type StatementCourier = 'jnt' | 'flash' | 'lbc' | 'ninja' | 'other'

/** One statement row, normalised. Matches what `cod_import_statement` expects. */
export interface StatementLine {
  waybill: string
  /** What the courier says it is paying for this parcel. */
  amount: Centavos
  /** What it deducted, when the statement itemises it separately. */
  fee: Centavos
  /** ISO date, or null when the statement does not say. */
  remittedAt: string | null
  /** The row as it appeared, so a seller can see what the file actually said. */
  raw: Record<string, string>
}

export interface ParsedStatement {
  courier: StatementCourier
  lines: StatementLine[]
  /** Header labels as found, for the "we read your file like this" confirmation. */
  columns: { waybill: string; amount: string; fee: string | null; date: string | null }
  /** Rows that looked like data but had no usable waybill or amount. */
  skipped: { row: number; reason: 'no_waybill' | 'no_amount'; cells: string[] }[]
  /** A payout total found in the file's preamble or footer, if there is one. */
  declaredTotal: Centavos | null
}

export class StatementError extends Error {
  /** Written out because `erasableSyntaxOnly` forbids parameter properties. */
  readonly code: StatementErrorCode
  constructor(code: StatementErrorCode) {
    super(code)
    this.name = 'StatementError'
    this.code = code
  }
}

export type StatementErrorCode =
  | 'empty_file'
  | 'no_header'
  | 'no_waybill_column'
  | 'no_amount_column'
  | 'no_rows'

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 with the concessions real files need.
 *
 * Quoted fields may contain commas, newlines and doubled quotes. Handles CRLF, a
 * UTF-8 BOM (Excel writes one, and it turns the first header into an invisible
 * U+FEFF followed by `Waybill`, which then matches nothing), and semicolon delimiters — which is what Excel emits
 * in locales that use a comma for decimals.
 */
export function parseCsv(text: string): Sheet {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = detectDelimiter(input)

  const rows: Sheet = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < input.length; i += 1) {
    const character = input[i]!

    if (quoted) {
      if (character === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && field === '') {
      quoted = true
    } else if (character === delimiter) {
      row.push(field.trim())
      field = ''
    } else if (character === '\n' || character === '\r') {
      // A lone \r, a lone \n, or \r\n all end one row.
      if (character === '\r' && input[i + 1] === '\n') i += 1
      row.push(field.trim())
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.trim())
    rows.push(row)
  }

  return rows
}

/**
 * Comma, semicolon or tab, whichever appears most outside quotes.
 *
 * Guessing rather than configuring, because a seller who has to pick a delimiter
 * has already been asked one question too many about a file they did not write.
 */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192)
  let quoted = false
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  for (const character of sample) {
    if (character === '"') quoted = !quoted
    else if (!quoted && counts[character] !== undefined) counts[character] += 1
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',') as string
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

/**
 * A money cell to centavos, with no floating point anywhere.
 *
 * `1,450.00`, `₱1,450.00`, `PHP 1450`, `(120.50)` for a negative, `1 450,00` from a
 * European-locale Excel. The decimal separator is decided by which of `.` and `,`
 * appears *last*, which is the only rule that gets both `1,450.00` and `1.450,00`
 * right.
 *
 * Returns null rather than 0 for something unparseable: a fee column that reads
 * "N/A" must not silently become a zero deduction, because zero is a claim.
 */
export function parseMoneyCentavos(input: string): Centavos | null {
  const text = input.trim()
  if (text === '') return null

  const negative = /^\(.*\)$/.test(text) || text.includes('-')
  // Strip currency, spaces (including the non-breaking kind Excel loves) and the
  // accounting parentheses. Keep digits and both separators.
  const cleaned = text.replace(/[^\d.,]/g, '')
  if (cleaned === '') return null

  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')
  let whole = cleaned
  let fraction = ''

  const decimalAt = Math.max(lastDot, lastComma)
  if (decimalAt >= 0) {
    const tail = cleaned.slice(decimalAt + 1)
    // Three digits after the last separator is a thousands group, not centavos:
    // `1,450` is one thousand four hundred and fifty pesos.
    if (tail.length <= 2 && /^\d*$/.test(tail)) {
      whole = cleaned.slice(0, decimalAt)
      fraction = tail
    }
  }

  const digits = whole.replace(/\D/g, '')
  if (digits === '' && fraction === '') return null

  const value = BigInt(digits === '' ? '0' : digits) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null

  return centavos(Number(negative ? -value : value))
}

/**
 * A date cell to an ISO date.
 *
 * Handles what couriers actually emit: `2026-07-31`, `31/07/2026`, `07/31/2026`,
 * `31-Jul-2026`, and the bare Excel serial that comes out of an `.xlsx` when the
 * cell is date-*formatted* rather than date-typed.
 *
 * Ambiguous `dd/mm` versus `mm/dd` is resolved as day-first, because Philippine
 * courier portals are day-first and the alternative is silently reading 7 July as
 * 31 July whenever the day is 12 or less.
 */
export function parseStatementDate(input: string): string | null {
  const text = input.trim()
  if (text === '') return null

  // Excel serial: days since 1899-12-30 (Lotus's leap-year bug included, which is
  // why the epoch is the 30th and not the 31st).
  if (/^\d{4,5}(\.\d+)?$/.test(text)) {
    const serial = Number.parseInt(text, 10)
    if (serial > 20000 && serial < 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000
      return new Date(ms).toISOString().slice(0, 10)
    }
  }

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text)
  if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`

  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(text)
  if (dmy) {
    const day = Number(dmy[1])
    const month = Number(dmy[2])
    // A "day" over 12 can only be a day, so a file that is actually mm/dd
    // announces itself and is read correctly anyway.
    return month > 12
      ? `${dmy[3]}-${pad(String(day))}-${pad(String(month))}`
      : `${dmy[3]}-${pad(String(month))}-${pad(String(day))}`
  }

  const named = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/.exec(text)
  if (named) {
    const month = MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase())
    if (month >= 0) return `${named[3]}-${pad(String(month + 1))}-${pad(named[1]!)}`
  }

  return null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (value: string) => value.padStart(2, '0')

// ---------------------------------------------------------------------------
// Column recognition
// ---------------------------------------------------------------------------

/**
 * Header aliases, per column, ordered by how specific they are.
 *
 * Matched on a normalised label (lowercase, punctuation stripped) with
 * `startsWith`/`includes` rather than equality, because couriers append units and
 * notes to their own headers — "COD Amount (PHP)", "Waybill No.*".
 *
 * `amount` deliberately does not include a bare `total`: a statement's *footer*
 * total and its per-row amount are different numbers, and matching the wrong one
 * turns every line into the whole payout.
 */
const ALIASES = {
  waybill: [
    'waybillno',
    'waybill',
    'awbno',
    'awb',
    'trackingno',
    'trackingnumber',
    'tracking',
    'consignmentno',
    'parcelno',
    'shipmentno',
    'referenceno',
  ],
  amount: [
    'codamount',
    'codvalue',
    'codcollected',
    'amountcollected',
    'collectedamount',
    'remittedamount',
    'amountremitted',
    'netamount',
    'payoutamount',
    'codfee', // never: filtered below, listed so the ordering is explicit
    'amount',
    'cod',
  ],
  fee: [
    'servicefee',
    'handlingfee',
    'codfee',
    'deliveryfee',
    'shippingfee',
    'charges',
    'deduction',
    'fee',
  ],
  date: ['remitteddate', 'remittedat', 'payoutdate', 'settlementdate', 'datepaid', 'date'],
} as const

function normalise(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Which column is which.
 *
 * The fee aliases are checked *first* and their columns removed from the amount
 * candidates. Otherwise "COD Fee" matches the `cod` alias and a seller's entire
 * payout is read as the courier's cut — a mistake that shows up as a five-figure
 * variance on every line, which at least fails loudly, but only after the seller
 * has stared at it for a while.
 */
function locateColumns(header: string[]): {
  waybill: number
  amount: number
  fee: number
  date: number
} {
  const labels = header.map(normalise)
  const taken = new Set<number>()

  const find = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const index = labels.findIndex(
        (label, i) => !taken.has(i) && label !== '' && (label === alias || label.startsWith(alias)),
      )
      if (index >= 0) return index
    }
    for (const alias of aliases) {
      const index = labels.findIndex(
        (label, i) => !taken.has(i) && label !== '' && label.includes(alias),
      )
      if (index >= 0) return index
    }
    return -1
  }

  const waybill = find(ALIASES.waybill)
  if (waybill >= 0) taken.add(waybill)
  const fee = find(ALIASES.fee)
  if (fee >= 0) taken.add(fee)
  const date = find(ALIASES.date)
  if (date >= 0) taken.add(date)
  const amount = find(ALIASES.amount)

  return { waybill, amount, fee, date }
}

/**
 * Find the header row.
 *
 * Courier exports put one to five rows of branding, a logo cell, a date range and a
 * blank line above the actual header. So the header is not row 0 — it is the first
 * row in which both a waybill-ish and an amount-ish column can be recognised.
 * Scanning for that rather than asking the seller to say "my header is on row 4" is
 * the whole difference between a feature that gets used and one that does not.
 */
function findHeader(rows: Sheet): { index: number; columns: ReturnType<typeof locateColumns> } {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const columns = locateColumns(rows[i] ?? [])
    if (columns.waybill >= 0 && columns.amount >= 0) return { index: i, columns }
  }
  // Report the more useful of the two failures: a file where we found a waybill
  // column but no money is a different conversation from a file that is not a
  // statement at all.
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const columns = locateColumns(rows[i] ?? [])
    if (columns.waybill >= 0) throw new StatementError('no_amount_column')
    if (columns.amount >= 0) throw new StatementError('no_waybill_column')
  }
  throw new StatementError('no_header')
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/** Words couriers put in the first column of a summary row. */
const FOOTER_LABEL = /^\s*(grand\s*)?(total|totals|sum|subtotal|net\s*(payout|amount)?)\s*:?\s*$/i

/** A waybill, as printed. Couriers pad, quote and occasionally lowercase them. */
function cleanWaybill(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, '').replace(/\s+/g, '').toUpperCase()
}

/**
 * Read a whole statement from an already-tabulated sheet.
 *
 * Shared by the CSV and XLSX paths, so the two cannot drift — the format the file
 * arrived in must not change what Selld thinks it says.
 */
export function parseStatementSheet(rows: Sheet, courier: StatementCourier): ParsedStatement {
  if (rows.length === 0) throw new StatementError('empty_file')

  const { index, columns } = findHeader(rows)
  const header = rows[index] ?? []

  const lines: StatementLine[] = []
  const skipped: ParsedStatement['skipped'] = []
  let declaredTotal: Centavos | null = null

  for (let i = index + 1; i < rows.length; i += 1) {
    const cells = rows[i] ?? []
    if (cells.every((cell) => cell === '')) continue

    const waybill = cleanWaybill(cells[columns.waybill] ?? '')
    const amount = parseMoneyCentavos(cells[columns.amount] ?? '')

    // A footer line — "TOTAL   ₱148,500.00" — is worth keeping rather than
    // discarding: it is the statement's own declared payout, and disagreeing with
    // it is a finding before any individual parcel is.
    //
    // Checked against the waybill *cell*, not only against an empty one: couriers
    // put the word TOTAL in the first column, which is usually the waybill column,
    // and treating it as a waybill imports the whole payout as a fourth parcel.
    if (FOOTER_LABEL.test(cells[columns.waybill] ?? '') || FOOTER_LABEL.test(cells[0] ?? '')) {
      if (amount !== null) declaredTotal = amount
      continue
    }

    if (waybill === '') {
      skipped.push({ row: i + 1, reason: 'no_waybill', cells })
      continue
    }

    if (amount === null) {
      skipped.push({ row: i + 1, reason: 'no_amount', cells })
      continue
    }

    const raw: Record<string, string> = {}
    for (let c = 0; c < header.length; c += 1) {
      const key = (header[c] ?? '').trim()
      if (key !== '') raw[key] = cells[c] ?? ''
    }

    lines.push({
      waybill,
      amount,
      fee: (columns.fee >= 0 ? parseMoneyCentavos(cells[columns.fee] ?? '') : null) ?? centavos(0),
      remittedAt: columns.date >= 0 ? parseStatementDate(cells[columns.date] ?? '') : null,
      raw,
    })
  }

  if (lines.length === 0) throw new StatementError('no_rows')

  return {
    courier,
    lines,
    columns: {
      waybill: header[columns.waybill] ?? '',
      amount: header[columns.amount] ?? '',
      fee: columns.fee >= 0 ? (header[columns.fee] ?? null) : null,
      date: columns.date >= 0 ? (header[columns.date] ?? null) : null,
    },
    skipped,
    declaredTotal,
  }
}

/**
 * Read a statement from whatever the seller uploaded.
 *
 * Sniffed by content, not by filename: a `.csv` that is really an `.xlsx` (Excel's
 * "save as" does this when the seller picks the wrong entry) would otherwise be
 * read as one long line of binary and reported as an empty file.
 */
export async function parseStatementFile(
  data: ArrayBuffer | Uint8Array,
  courier: StatementCourier,
  readSheet: (bytes: ArrayBuffer | Uint8Array) => Promise<Sheet>,
): Promise<ParsedStatement> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  // Every ZIP — and therefore every xlsx — starts `PK\x03\x04`.
  const isZip =
    bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

  const rows = isZip ? await readSheet(bytes) : parseCsv(new TextDecoder().decode(bytes))
  return parseStatementSheet(rows, courier)
}

/** The payload `cod_import_statement()` takes. */
export function toImportPayload(statement: ParsedStatement): {
  waybill: string
  amount: number
  fee: number
  remittedAt: string | null
  raw: Record<string, string>
}[] {
  return statement.lines.map((line) => ({
    waybill: line.waybill,
    amount: line.amount as number,
    fee: line.fee as number,
    remittedAt: line.remittedAt,
    raw: line.raw,
  }))
}
