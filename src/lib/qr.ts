import qrcode from 'qrcode-generator'

/**
 * QR encoding, kept out of the component that draws it.
 *
 * `qrcode-generator` rather than a hand-rolled encoder. The encoding is
 * Reed-Solomon over GF(256) plus eight mask patterns and a BCH format field, and
 * the failure mode of getting any of it subtly wrong is a code that renders
 * beautifully and scans to nothing — which the seller discovers after printing
 * two hundred of them. It is 52KB, zero-dependency and MIT, and it lands in the
 * dashboard chunk; nothing under `src/storefront/**` may import this file.
 *
 * Error correction level M (~15% recoverable) throughout. H would survive a logo
 * punched through the middle, at the cost of a denser code; M is what a printed
 * URL wants, and there is no logo in the middle.
 */

/** One module of quiet zone short of the spec's four, on each side.
 *
 * The spec assumes a code printed against arbitrary artwork. This one sits on a
 * white card, and four modules of margin at 160px wastes a fifth of the width. */
const MARGIN = 2

function encode(value: string) {
  // Type 0 = smallest version that fits. Byte mode, which is what a URL is.
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()
  return qr
}

export interface QrPath {
  /** Modules per side, quiet zone included. Use as the SVG viewBox extent. */
  size: number
  /** Offset the path by this many modules on both axes. */
  margin: number
  /** Every dark module, as one SVG path `d`. */
  d: string
}

/**
 * The dark modules as a single `<path>`.
 *
 * One path rather than one `<rect>` per module: a version-4 code is 33×33, so
 * roughly 500 dark modules, and 500 elements is a measurable amount of DOM for a
 * picture. Horizontal runs merge into one rectangle each, which halves it again.
 */
export function qrPath(value: string): QrPath {
  const qr = encode(value)
  const count = qr.getModuleCount()
  const parts: string[] = []

  for (let row = 0; row < count; row += 1) {
    let start = -1
    // One past the end, so a run touching the right edge still gets closed.
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && qr.isDark(row, col)
      if (dark && start === -1) {
        start = col
      } else if (!dark && start !== -1) {
        const run = col - start
        parts.push(`M${String(start)} ${String(row)}h${String(run)}v1h-${String(run)}z`)
        start = -1
      }
    }
  }

  return { size: count + MARGIN * 2, margin: MARGIN, d: parts.join('') }
}

/**
 * Render the code to a PNG and hand it to the browser's downloader.
 *
 * PNG rather than the SVG that is on screen, because the destination is usually
 * Facebook, Canva or a print shop's email, and every one of those takes a PNG
 * without a conversation. Drawn module-by-module onto a canvas rather than
 * rasterising the SVG through an `<img>`, which taints the canvas in some
 * browsers and needs a load round trip in all of them.
 */
export function downloadQrPng(value: string, fileName: string, pixels = 1024): void {
  const qr = encode(value)
  const count = qr.getModuleCount()
  const modules = count + MARGIN * 2
  // Whole pixels per module, or rows land on half-pixels and a scanner reads a
  // blurred grid. The canvas is sized to fit rather than the other way round.
  const scale = Math.max(1, Math.floor(pixels / modules))
  const size = modules * scale

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context === null) return

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size, size)
  context.fillStyle = '#000000'
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        context.fillRect((col + MARGIN) * scale, (row + MARGIN) * scale, scale, scale)
      }
    }
  }

  canvas.toBlob((blob) => {
    if (blob === null) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
