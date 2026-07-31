import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

/**
 * Forty labels, one PDF.
 *
 * The done-when says the file *downloads*, so this really does produce a single
 * PDF rather than leaning on the browser's print dialog the way phase 9's packing
 * slips do. The difference is where the content lives: packing slips are ours and
 * already on the page, labels are forty files on a courier's CDN.
 *
 * Three things make this fit inside 30 seconds:
 *
 * 1. **Labels are fetched in parallel**, bounded. Forty sequential fetches at a
 *    provincial RTT is most of the budget spent waiting.
 * 2. **A label that fails to fetch becomes a placeholder page, not an error.** A
 *    seller with 39 good labels and one missing needs the 39 printed now and the
 *    one named clearly — not a failed download and no labels at all.
 * 3. **Both PDF and image labels are handled.** J&T returns PDFs, Flash returns
 *    PNGs, and a merger that assumed either would work for exactly one courier.
 */

export interface LabelRef {
  orderNumber: string
  waybill: string
  courier: string
  labelUrl: string | null
}

/** Bounded concurrency: enough to hide latency, not enough to look like an attack. */
const FETCH_CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 10_000

async function fetchLabel(
  ref: LabelRef,
  fetchImpl: typeof fetch,
): Promise<{ ref: LabelRef; bytes: Uint8Array; contentType: string } | { ref: LabelRef }> {
  if (ref.labelUrl === null || ref.labelUrl === '') return { ref }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(ref.labelUrl, { signal: controller.signal })
    if (!response.ok) return { ref }
    const buffer = new Uint8Array(await response.arrayBuffer())
    return {
      ref,
      bytes: buffer,
      contentType: response.headers.get('content-type') ?? 'application/pdf',
    }
  } catch {
    return { ref }
  } finally {
    clearTimeout(timer)
  }
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

export interface MergeResult {
  bytes: Uint8Array
  /** Labels that could not be fetched, so the caller can tell the seller. */
  missing: LabelRef[]
}

export async function mergeLabels(
  labels: readonly LabelRef[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<MergeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const fetched = await mapWithLimit(labels, FETCH_CONCURRENCY, (ref) =>
    fetchLabel(ref, fetchImpl),
  )

  const merged = await PDFDocument.create()
  const font = await merged.embedFont(StandardFonts.Helvetica)
  const missing: LabelRef[] = []

  // Sequential, and deliberately so: the fetching was the slow part and is already
  // done, while pdf-lib's document is single-threaded state that parallel writes
  // would corrupt. Page order also has to match the seller's list.
  for (const item of fetched) {
    if (!('bytes' in item)) {
      missing.push(item.ref)
      addPlaceholder(merged, font, item.ref)
      continue
    }

    try {
      if (item.contentType.includes('pdf') || looksLikePdf(item.bytes)) {
        const source = await PDFDocument.load(item.bytes)
        const pages = await merged.copyPages(source, source.getPageIndices())
        for (const page of pages) merged.addPage(page)
      } else {
        const image = item.contentType.includes('png')
          ? await merged.embedPng(item.bytes)
          : await merged.embedJpg(item.bytes)
        // A 4x6in thermal label at 72dpi. Scaled to fit rather than stretched, so a
        // courier that returns a differently-shaped image still prints readably.
        const page = merged.addPage([288, 432])
        const scale = Math.min(288 / image.width, 432 / image.height)
        page.drawImage(image, {
          x: (288 - image.width * scale) / 2,
          y: (432 - image.height * scale) / 2,
          width: image.width * scale,
          height: image.height * scale,
        })
      }
    } catch {
      // A label that is not the format its content-type claimed.
      missing.push(item.ref)
      addPlaceholder(merged, font, item.ref)
    }
  }

  return { bytes: await merged.save(), missing }
}

/**
 * A page that says which label is missing.
 *
 * Not an omission: a seller counting 39 pages against 40 parcels has no way to tell
 * *which* one is absent, and would have to open every order to find out.
 */
function addPlaceholder(
  document: PDFDocument,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  ref: LabelRef,
): void {
  const page = document.addPage([288, 432])
  const lines = [
    'LABEL NOT AVAILABLE',
    '',
    `Order ${ref.orderNumber}`,
    `${ref.courier.toUpperCase()} ${ref.waybill}`,
    '',
    'The parcel is booked. Reprint this',
    'label from the order, or from the',
    "courier's own dashboard.",
  ]
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: 24,
      y: 380 - index * 20,
      size: index === 0 ? 14 : 11,
      font,
      color: rgb(0, 0, 0),
    })
  })
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF"
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}
