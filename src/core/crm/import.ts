/**
 * Turning somebody else's export into a customer list.
 *
 * ## The problem this solves
 *
 * A seller moving to Selld already has customers — a few hundred of them, in a
 * Shopee export, a Lazada export, a TikTok Shop export, and a spreadsheet a
 * cousin typed by hand. Every one of those files is an *order* export, not a
 * customer list: one row per order, the same buyer on nine of them, the name in
 * a column called something different in each file, and the phone written four
 * ways.
 *
 * So this module answers exactly three questions and nothing else:
 *
 *   1. which row is the header, given that most exports have branding above it
 *   2. which columns are the name, the phone, the email
 *   3. which rows are actually a person
 *
 * Whether that person is *new* is decided in `customers_import()`, against the
 * seller's own table, because a client that could assert "this is a new
 * customer" could assert one over the top of an existing one.
 *
 * ## Why the name column is a judgement call
 *
 * Shopee gives you both `Username (Buyer)` and `Receiver Name`. The username is
 * `rhea_finds_28` and the receiver is `Rhea Santos`, and a customer list full of
 * usernames is a customer list nobody can send a message to. So the aliases are
 * ordered by preference, not just matched — the recipient of the parcel beats
 * the account that placed the order, every time.
 */

import { parseCsv } from '@/core/cod/statement'
import { readXlsx, type Sheet } from '@/core/cod/xlsx'

export type ImportSource = 'shopee' | 'lazada' | 'tiktok' | 'generic'

export interface ImportedCustomer {
  name: string
  /** E.164, `+63…`. Rows that cannot produce one are not people. */
  phone: string
  email: string | null
  note: string | null
}

export interface ParsedCustomerFile {
  source: ImportSource
  rows: ImportedCustomer[]
  /** Which header label each field was read from, for the confirmation screen. */
  columns: { name: string | null; phone: string | null; email: string | null }
  /** The same person on more than one order row. Collapsed, and counted. */
  duplicates: number
  skipped: { row: number; reason: 'no_phone' | 'no_name' | 'not_mobile'; cells: string[] }[]
}

export class CustomerImportError extends Error {
  readonly code: 'empty' | 'no_header' | 'no_phone_column'
  constructor(code: 'empty' | 'no_header' | 'no_phone_column') {
    super(code)
    this.name = 'CustomerImportError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Column aliases
// ---------------------------------------------------------------------------
/**
 * In preference order, most specific first.
 *
 * `contains`, not equality: exports append units, ids and stray spaces to their
 * own headers — `Phone Number (Receiver)`, `Recipient's Phone #`, `shippingPhone`
 * — and a header map keyed on exact strings is a map that breaks the first time
 * a marketplace ships a new column.
 */
const NAME_ALIASES = [
  'receiver name',
  'recipient name',
  'recipient',
  'shipping name',
  'shippingname',
  'customer name',
  'customername',
  'buyer name',
  'contact name',
  'full name',
  'pangalan',
  'name',
  // Last: a username is an account, not a person, and it is what you fall back
  // to only when the file gives you nothing better.
  'username (buyer)',
  'buyer username',
  'username',
]

const PHONE_ALIASES = [
  'receiver phone',
  'recipient phone',
  "recipient's phone",
  'shipping phone',
  'shippingphone',
  'phone number',
  'contact number',
  'mobile number',
  'mobile',
  'cellphone',
  'contact no',
  'phone no',
  'phone #',
  'telepono',
  'phone',
  'tel',
]

const EMAIL_ALIASES = ['email address', 'buyer email', 'email', 'e-mail']

const NOTE_ALIASES = ['remark', 'note', 'buyer note', 'message to seller', 'notes']

/** Fingerprints that name the file without asking the seller. */
const SOURCE_HINTS: { source: ImportSource; markers: string[] }[] = [
  // Ordered most-distinctive first, and none of the markers is `order id` —
  // every marketplace on earth has a column called that, and using it made a
  // TikTok export identify as Shopee.
  { source: 'tiktok', markers: ['buyer username', 'sku subtotal after discount'] },
  { source: 'shopee', markers: ['username (buyer)', 'tracking number*'] },
  { source: 'lazada', markers: ['ordernumber', 'shippingname'] },
]

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

function findColumn(header: string[], aliases: string[]): number {
  const cells = header.map(normalise)
  for (const alias of aliases) {
    const exact = cells.indexOf(alias)
    if (exact >= 0) return exact
  }
  for (const alias of aliases) {
    const partial = cells.findIndex((cell) => cell !== '' && cell.includes(alias))
    if (partial >= 0) return partial
  }
  return -1
}

/**
 * The header is the first row that names a phone column.
 *
 * Not "row 0", and not "the widest row": a Shopee export opens with the shop
 * name, the export date range and a blank line, and a Lazada one puts a legal
 * notice above the table. Anchoring on the phone column is deliberate — it is
 * the one field this import cannot proceed without, so a file whose header we
 * cannot find is a file we should refuse rather than half-read.
 */
function findHeaderRow(rows: Sheet): number {
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const row = rows[index] ?? []
    if (findColumn(row, PHONE_ALIASES) >= 0 && findColumn(row, NAME_ALIASES) >= 0) return index
  }
  return -1
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------
/**
 * A PH mobile number, or null.
 *
 * Deliberately strict, and deliberately duplicated from `src/lib/phone` in
 * *intent* rather than by import: this runs over a spreadsheet, where the input
 * is not "what a person typed into a field" but "whatever survived a round trip
 * through Excel". The shapes that turn up here and nowhere else:
 *
 *   `9.17123E+11`  Excel decided a phone number was a float
 *   `63917 123 4567` / `0917-123-4567` / `+63 (917) 123 4567`
 *   `09171234567 / 09281234567`  two numbers in one cell
 *   `'09171234567`  a leading apostrophe, forcing text
 *
 * Landlines are refused rather than stored. Every outbound channel Selld has —
 * SMS, Messenger, a tracking link — needs a mobile, and a customer record whose
 * number cannot be messaged is a row that will silently fail later.
 */
export function toPhMobile(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim()
  if (raw === '') return null

  // Excel's scientific notation, restored to digits — but only when the mantissa
  // still carries every one of them.
  //
  // `9.171234567E+9` is 9171234567 and can be read back exactly. `9.17123E+09`
  // is what Excel *displays* at six significant figures, and the digits after
  // the sixth are simply gone: padding it with zeroes would produce
  // `+639171230000`, which is a real phone number belonging to somebody else.
  // A number we cannot restore is refused, and the seller fixes the column
  // format and exports again.
  let text = raw
  const scientific = /^(\d)\.(\d+)e\+?(\d+)$/i.exec(raw.replace(/\s/g, ''))
  if (scientific !== null) {
    const digits = `${scientific[1]}${scientific[2]}`
    const exponent = Number(scientific[3])
    text = digits.length === exponent + 1 ? digits : ''
  }

  // Two numbers in one cell: take the first that works.
  const candidates = text.split(/[/;]|\bor\b|,/i)
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, '')
    const national = digits.replace(/^(63|0)/, '')
    if (/^9\d{9}$/.test(national)) return `+63${national}`
  }
  return null
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------
export function parseCustomerSheet(rows: Sheet): ParsedCustomerFile {
  if (rows.length === 0) throw new CustomerImportError('empty')

  const headerIndex = findHeaderRow(rows)
  if (headerIndex < 0) throw new CustomerImportError('no_header')

  const header = rows[headerIndex] ?? []
  const nameAt = findColumn(header, NAME_ALIASES)
  const phoneAt = findColumn(header, PHONE_ALIASES)
  const emailAt = findColumn(header, EMAIL_ALIASES)
  const noteAt = findColumn(header, NOTE_ALIASES)

  if (phoneAt < 0) throw new CustomerImportError('no_phone_column')

  const fingerprint = header.map(normalise).join('|')
  const source =
    SOURCE_HINTS.find((hint) => hint.markers.some((marker) => fingerprint.includes(marker)))
      ?.source ?? 'generic'

  const rowsOut: ImportedCustomer[] = []
  const skipped: ParsedCustomerFile['skipped'] = []
  const seen = new Map<string, number>()
  let duplicates = 0

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? []
    if (row.every((cell) => cell.trim() === '')) continue

    const rawPhone = (row[phoneAt] ?? '').trim()
    const name = (nameAt >= 0 ? (row[nameAt] ?? '') : '').trim()

    if (rawPhone === '') {
      skipped.push({ row: index + 1, reason: 'no_phone', cells: row })
      continue
    }
    const phone = toPhMobile(rawPhone)
    if (phone === null) {
      skipped.push({ row: index + 1, reason: 'not_mobile', cells: row })
      continue
    }
    if (name === '') {
      skipped.push({ row: index + 1, reason: 'no_name', cells: row })
      continue
    }

    // One buyer, nine orders, one customer. The first row wins because export
    // files are newest-first often enough that it is the freshest spelling of
    // their name.
    const already = seen.get(phone)
    if (already !== undefined) {
      duplicates += 1
      const existing = rowsOut[already]
      if (existing !== undefined && existing.email === null && emailAt >= 0) {
        existing.email = (row[emailAt] ?? '').trim() || null
      }
      continue
    }

    seen.set(phone, rowsOut.length)
    rowsOut.push({
      name,
      phone,
      email: emailAt >= 0 ? (row[emailAt] ?? '').trim() || null : null,
      note: noteAt >= 0 ? (row[noteAt] ?? '').trim() || null : null,
    })
  }

  return {
    source,
    rows: rowsOut,
    columns: {
      name: nameAt >= 0 ? (header[nameAt] ?? null) : null,
      phone: header[phoneAt] ?? null,
      email: emailAt >= 0 ? (header[emailAt] ?? null) : null,
    },
    duplicates,
    skipped,
  }
}

/** CSV or XLSX, decided by the bytes rather than by the file extension. */
export async function parseCustomerFile(
  data: ArrayBuffer | Uint8Array,
): Promise<ParsedCustomerFile> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  // `PK\x03\x04` — a zip, which is what an xlsx is. A seller who renamed a file
  // to .csv still gets it read correctly.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  const rows = isZip ? await readXlsx(bytes) : parseCsv(new TextDecoder().decode(bytes))
  return parseCustomerSheet(rows)
}
