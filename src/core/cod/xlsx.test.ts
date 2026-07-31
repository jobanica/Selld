import { describe, expect, it } from 'vitest'

import { pesos } from '@/lib/money'

import { parseStatementSheet } from './statement'
import { columnIndex, decodeXmlText, readXlsx, XlsxError } from './xlsx'

/**
 * Built rather than checked in.
 *
 * A binary fixture in the repo is a thing nobody can review — a reader would have
 * to take on trust that it contains what the test says it does. Writing the ZIP
 * here means the bytes under test are visible in the same file as the assertions,
 * and the writer is deliberately dumb (stored entries, no compression) so a bug in
 * it cannot mask a bug in the reader.
 *
 * The deflate path is exercised separately by round-tripping through
 * `CompressionStream`, which is the same implementation browsers use.
 */

const encoder = new TextEncoder()

/** CRC-32, needed because a ZIP reader is entitled to check it. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as BufferSource)
      controller.close()
    },
  })
  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A minimal ZIP writer: local headers, then a central directory, then the EOCD. */
async function makeZip(
  files: { name: string; content: string }[],
  { compress = false } = {},
): Promise<Uint8Array> {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const raw = encoder.encode(file.content)
    const stored = compress ? await deflateRaw(raw) : raw
    const method = compress ? 8 : 0
    const crc = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length + stored.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, stored.length, true)
    localView.setUint32(22, raw.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(stored, 30 + nameBytes.length)
    locals.push(local)

    const entry = new Uint8Array(46 + nameBytes.length)
    const entryView = new DataView(entry.buffer)
    entryView.setUint32(0, 0x02014b50, true)
    entryView.setUint16(4, 20, true)
    entryView.setUint16(6, 20, true)
    entryView.setUint16(10, method, true)
    entryView.setUint32(16, crc, true)
    entryView.setUint32(20, stored.length, true)
    entryView.setUint32(24, raw.length, true)
    entryView.setUint16(28, nameBytes.length, true)
    entryView.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)

    offset += local.length
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  const total = [...locals, ...central, end]
  const out = new Uint8Array(total.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of total) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const SHARED_STRINGS = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
  <si><t>Waybill No.</t></si>
  <si><t>COD Amount</t></si>
  <si><t>Remitted Date</t></si>
  <si><t>JT2607310001</t></si>
  <si><r><t>JT</t></r><r><t>2607310002</t></r></si>
  <si><t>&#8369;1,450.00</t></si>
</sst>`

/**
 * The awkward parts, on purpose:
 *
 * - two branding rows above the header, as every courier export has
 * - a shared string split across two runs (row 5's waybill), which a parser that
 *   takes the first `<t>` reads as `JT`
 * - a row with a gap: `A6` then `C6`, no `B6`. A parser that appends cells in
 *   document order puts the date in the amount column.
 * - a peso sign as a numeric character reference, which is how Excel writes it
 * - a date as a bare serial, because the cell is date-*formatted*, not date-typed
 */
const SHEET = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>J&amp;T EXPRESS PHILIPPINES</t></is></c></row>
  <row r="2"/>
  <row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c></row>
  <row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" t="s"><v>5</v></c><c r="C4"><v>46218</v></c></row>
  <row r="5"><c r="A5" t="s"><v>4</v></c><c r="B5"><v>378</v></c><c r="C5"><v>46218</v></c></row>
  <row r="6"><c r="A6" t="inlineStr"><is><t>JT2607310003</t></is></c><c r="C6"><v>46219</v></c></row>
</sheetData>
</worksheet>`

const FILES = [
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: 'xl/sharedStrings.xml', content: SHARED_STRINGS },
  { name: 'xl/worksheets/sheet1.xml', content: SHEET },
]

describe('columnIndex', () => {
  it('reads spreadsheet column letters as base-26 with no zero', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('B12')).toBe(1)
    expect(columnIndex('Z1')).toBe(25)
    expect(columnIndex('AA1')).toBe(26)
    expect(columnIndex('BC7')).toBe(54)
  })
})

describe('decodeXmlText', () => {
  it('decodes the peso sign Excel writes as a character reference', () => {
    expect(decodeXmlText('&#8369;1,450.00')).toBe('₱1,450.00')
    expect(decodeXmlText('&#x20B1;1')).toBe('₱1')
    expect(decodeXmlText('J&amp;T')).toBe('J&T')
  })
})

describe('readXlsx', () => {
  it('reads a stored (uncompressed) workbook', async () => {
    const sheet = await readXlsx(await makeZip(FILES))
    expect(sheet[2]).toEqual(['Waybill No.', 'COD Amount', 'Remitted Date'])
  })

  it('reads a deflated workbook, which is what Excel actually writes', async () => {
    const sheet = await readXlsx(await makeZip(FILES, { compress: true }))
    expect(sheet[2]).toEqual(['Waybill No.', 'COD Amount', 'Remitted Date'])
  })

  it('joins a shared string split across formatting runs', async () => {
    // Taking the first `<t>` reads this waybill as `JT`, which then matches
    // nothing and lands as an unknown waybill — a phantom "the courier paid us
    // for a parcel we never shipped".
    const sheet = await readXlsx(await makeZip(FILES))
    expect(sheet[4]?.[0]).toBe('JT2607310002')
  })

  it('places cells by reference, so a gap does not shift the row left', async () => {
    // Row 6 has A and C but no B. Appending in document order would put the date
    // in the amount column and read a parcel's payout as 46219 centavos.
    const sheet = await readXlsx(await makeZip(FILES))
    expect(sheet[5]).toEqual(['JT2607310003', '', '46219'])
  })

  it('refuses something that is not a workbook, with a reason', async () => {
    await expect(readXlsx(encoder.encode('this is a csv, actually'))).rejects.toThrow(XlsxError)
    await expect(readXlsx(await makeZip([{ name: 'a.txt', content: 'x' }]))).rejects.toMatchObject({
      code: 'no_worksheet',
    })
  })
})

describe('an xlsx statement, end to end', () => {
  it('reads a real workbook the way it reads a CSV', async () => {
    const statement = parseStatementSheet(await readXlsx(await makeZip(FILES, { compress: true })), 'jnt')

    expect(statement.columns.waybill).toBe('Waybill No.')
    // Two usable lines. The third row has a waybill and a date but no amount,
    // which is a row to report, not a payment to invent.
    expect(statement.lines.map((line) => line.waybill)).toEqual([
      'JT2607310001',
      'JT2607310002',
    ])
    // The peso sign came through as a character reference and the amount is still
    // exact centavos.
    expect(statement.lines[0]?.amount).toBe(pesos('1450'))
    expect(statement.lines[1]?.amount).toBe(pesos('378'))
    // Serial 46218 is 2026-07-15.
    expect(statement.lines[0]?.remittedAt).toBe('2026-07-15')
    // Row 6 had no amount cell at all, so it is reported rather than invented.
    expect(statement.skipped).toEqual([
      { row: 6, reason: 'no_amount', cells: ['JT2607310003', '', '46219'] },
    ])
  })
})
