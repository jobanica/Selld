/**
 * A minimal `.xlsx` reader — enough to get the cells out of a courier's payout
 * statement, and deliberately nothing more.
 *
 * ## Why this is hand-written instead of a dependency
 *
 * Every courier's merchant portal exports remittance statements as `.xlsx`. A
 * seller told "please convert it to CSV first" will not do it — that instruction is
 * the reason the feature goes unused. So the format has to be read.
 *
 * The obvious answer is SheetJS, and it is the wrong one here. This parses a file a
 * *user uploads*, which makes it an attack surface, and a full spreadsheet library
 * is a large one: formula evaluation, external references, a dozen legacy formats,
 * a history of CVEs, and — since it left the npm registry — a supply chain that no
 * longer looks like everything else in the lockfile. Against that, the part of the
 * format we actually need is small: an `.xlsx` is a ZIP of XML, the cells are in
 * `xl/worksheets/sheet1.xml`, and the strings are in `xl/sharedStrings.xml`.
 *
 * So this reads exactly that, with no formula evaluation, no external references,
 * no macros and no recursion. What it cannot parse, it refuses.
 *
 * ## Why it is async, and why there is no `zlib` import
 *
 * The parse runs in the seller's browser — it is their own file, and a 3,000-row
 * spreadsheet has no business making two network trips to be read. That rules out
 * `node:zlib`, so inflation goes through `DecompressionStream('deflate-raw')`,
 * which browsers and Node 18+ both provide as a global. One code path, tested on
 * the same implementation it ships on.
 *
 * ## What it does not do
 *
 * - Only the first worksheet. A courier statement has one sheet.
 * - Only `deflate` and `store`, which is all Excel and Google Sheets emit.
 * - No styles, so a date written as a number format comes back as the underlying
 *   serial. `statement.ts` converts those, because it is the layer that knows a
 *   column is meant to hold a date.
 * - Values only. Formulas are ignored in favour of their cached result, which is
 *   what a spreadsheet already stores next to them.
 */

/** A worksheet as rows of trimmed strings. Blank cells are `''`, not holes. */
export type Sheet = string[][]

const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ROWS = 100_000

/** Short, machine-readable, and meant to be mapped to seller-facing copy. */
export class XlsxError extends Error {
  // Written out rather than as a constructor parameter property: this project has
  // `erasableSyntaxOnly` on, so the shorthand is a compile error.
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'XlsxError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  offset: number
  compression: number
  compressedSize: number
  uncompressedSize: number
}

/**
 * Read the central directory rather than scanning local headers.
 *
 * A local file header is allowed to lie about its sizes — that is what the data
 * descriptor exists for — while the central directory is authoritative. Walking
 * local headers is also how a ZIP parser ends up following a crafted chain off the
 * end of the buffer.
 */
function readCentralDirectory(view: DataView): Map<string, ZipEntry> {
  const decoder = new TextDecoder()

  // The end-of-central-directory record sits at the tail, after a comment of up
  // to 64KB. Scan backwards for its signature.
  const floor = Math.max(0, view.byteLength - 0xffff - 22)
  let end = -1
  for (let i = view.byteLength - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new XlsxError('not_a_zip')

  const count = view.getUint16(end + 10, true)
  let position = view.getUint32(end + 16, true)
  const entries = new Map<string, ZipEntry>()

  for (let i = 0; i < count; i += 1) {
    if (position + 46 > view.byteLength) throw new XlsxError('truncated_zip')
    if (view.getUint32(position, true) !== 0x02014b50) throw new XlsxError('bad_central_header')

    const compression = view.getUint16(position + 10, true)
    const compressedSize = view.getUint32(position + 20, true)
    const uncompressedSize = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const offset = view.getUint32(position + 42, true)

    const name = decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + position + 46, nameLength),
    )
    entries.set(name, { name, offset, compression, compressedSize, uncompressedSize })
    position += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * Built from `ReadableStream` and drained by hand rather than going through
 * `Blob.stream()` or `new Response(...)`.
 *
 * Both of those are DOM conveniences, and neither is reliably present everywhere
 * this runs: jsdom ships a `Blob` with no `.stream()`, so the test suite would
 * exercise a different code path from the browser — or, worse, not exercise this
 * one at all. `ReadableStream` and `DecompressionStream` are the same objects in
 * Node and in a browser.
 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as BufferSource)
      controller.close()
    },
  })

  // `DecompressionStream` is typed as accepting `BufferSource`, so the source has
  // to be declared that way or the pipe does not type-check.
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    if (size > MAX_ENTRY_BYTES) throw new XlsxError('entry_too_large')
  }

  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function readEntry(view: DataView, entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new XlsxError('entry_too_large')
  if (entry.offset + 30 > view.byteLength) throw new XlsxError('truncated_zip')
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new XlsxError('bad_local_header')

  // The local header's own name/extra lengths are the ones that describe *this*
  // header, and they legitimately differ from the central directory's.
  const nameLength = view.getUint16(entry.offset + 26, true)
  const extraLength = view.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const raw = new Uint8Array(view.buffer, view.byteOffset + start, entry.compressedSize)

  if (entry.compression === 0) return new TextDecoder().decode(raw)
  if (entry.compression === 8) return new TextDecoder().decode(await inflateRaw(raw))
  throw new XlsxError('unsupported_compression')
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * Decode XML text.
 *
 * Numeric character references are decoded because Excel emits them for anything
 * outside its escape set — including `₱`, which appears in the amount column of
 * roughly every Philippine courier statement ever exported.
 */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity] ?? match
  })
}

function innerText(xml: string): string {
  let text = ''
  for (const part of xml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []) {
    text += decodeXmlText(part.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))
  }
  return text
}

/**
 * The shared string table.
 *
 * Excel stores every distinct string once and refers to it by index, so a cell of
 * type `s` holds a number. A run of formatting splits one string across several
 * `<t>` elements inside an `<si>`, which is why the text is concatenated rather
 * than taken from the first match — otherwise a waybill where someone bolded the
 * prefix reads as three characters.
 */
function readSharedStrings(xml: string): string[] {
  return (xml.match(ELEMENTS.si) ?? []).map(innerText)
}

/**
 * Element matchers, with the self-closing form *first*.
 *
 * Order in the alternation is load-bearing. With `<x>…</x>` tried first, a
 * self-closing `<row r="2"/>` fails that branch at its own position, and the regex
 * engine then matches it starting there against… nothing, so it advances — and the
 * `[\s\S]*?` in the first branch happily runs from `<row r="2"/>` to the *next*
 * row's `</row>`, swallowing a real row of data. In a courier statement that is a
 * silently missing parcel: an empty spacer row above the totals eats the last line
 * of the file and the seller reconciles one payment short with no error anywhere.
 *
 * `[^>]*` on the opening tag rather than `[\s\S]*?` for the same reason — it
 * cannot run past the end of the tag it is supposed to describe.
 */
const ELEMENTS = {
  si: /<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g,
  row: /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g,
  cell: /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g,
}

/** `BC7` -> 54. Column letters are base-26 with no zero. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? ''
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function readSheet(xml: string, shared: string[]): Sheet {
  const rows: Sheet = []

  for (const rowXml of xml.match(ELEMENTS.row) ?? []) {
    if (rows.length >= MAX_ROWS) break
    const cells: string[] = []

    for (const cellXml of rowXml.match(ELEMENTS.cell) ?? []) {
      const reference = /\br="([A-Z]+\d+)"/.exec(cellXml)?.[1] ?? ''
      const type = /\bt="([^"]+)"/.exec(cellXml)?.[1] ?? 'n'

      let value: string
      if (type === 'inlineStr') {
        value = innerText(cellXml)
      } else {
        // `<v>` is the value — and for a formula cell it is the *cached result*,
        // which is exactly what we want and why no evaluator is needed.
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? ''
        value = type === 's' ? (shared[Number(raw)] ?? '') : decodeXmlText(raw)
      }

      // Placed by cell reference, not by order. A row with empty cells omits them
      // entirely, so appending would shift every later column left — silently
      // reading the amount column as the date.
      const index = reference === '' ? cells.length : columnIndex(reference)
      while (cells.length < index) cells.push('')
      cells[index] = value.trim()
    }

    rows.push(cells)
  }

  return rows
}

/**
 * Read the first worksheet of an `.xlsx` file.
 *
 * Throws an `XlsxError` with a short code rather than a stack trace, because the
 * caller has to turn this into something a seller can act on: "that file is not a
 * spreadsheet" beats "Cannot read properties of undefined".
 */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<Sheet> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const entries = readCentralDirectory(view)

  // The workbook names its sheets in relationship order, but every producer we
  // care about writes the first as `sheet1.xml`. Fall back to whatever worksheet
  // exists rather than failing on a file that is otherwise fine.
  const sheetName =
    [...entries.keys()].find((name) => name === 'xl/worksheets/sheet1.xml') ??
    [...entries.keys()].filter((name) => /^xl\/worksheets\/.*\.xml$/.test(name)).sort()[0]

  if (sheetName === undefined) throw new XlsxError('no_worksheet')

  const sharedEntry = entries.get('xl/sharedStrings.xml')
  const shared =
    sharedEntry === undefined ? [] : readSharedStrings(await readEntry(view, sharedEntry))

  return readSheet(await readEntry(view, entries.get(sheetName)!), shared)
}
