import { deflateSync } from 'node:zlib'

/**
 * Placeholder product images, generated rather than committed.
 *
 * The storefront's whole reason for existing as a server-rendered surface is an
 * LCP budget, and LCP is almost always an image. Measuring it against a store
 * with no photos would flatter the number badly, and committing a few binary
 * JPEGs to the repository to avoid that is worse — they would be dead weight in
 * every clone forever.
 *
 * So the demo seed generates them. A smooth radial gradient at 900×900 encodes to
 * roughly 60KB of PNG, which is the right order of magnitude for a product photo
 * a seller has actually optimised. Deliberately *not* dithered: adding noise
 * pushes the same image past 300KB, which would make the Lighthouse run
 * pessimistic in a way real stores are not.
 *
 * Pure zlib, no image library. PNG is a simple enough container that pulling in a
 * dependency for this — one used only by a dev fixture — is not worth the install.
 */

function crcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

const CRC = crcTable()

function crc32(buffer: Buffer): number {
  let result = 0xffffffff
  for (const byte of buffer) result = (CRC[(result ^ byte) & 0xff] ?? 0) ^ (result >>> 8)
  return (result ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

export type Rgb = readonly [number, number, number]

/** A radial two-colour gradient as a PNG. */
export function gradientPng(size: number, inner: Rgb, outer: Rgb): Buffer {
  // One filter byte per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let cursor = 0

  for (let y = 0; y < size; y += 1) {
    raw[cursor] = 0 // filter type: none
    cursor += 1
    for (let x = 0; x < size; x += 1) {
      const dx = x / size - 0.5
      const dy = y / size - 0.5
      const distance = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.9)
      // Smoothstep, so the centre reads as a soft highlight rather than a cone.
      const t = distance * distance * (3 - 2 * distance)
      for (let channel = 0; channel < 3; channel += 1) {
        const value = (inner[channel] ?? 0) * (1 - t) + (outer[channel] ?? 0) * t
        raw[cursor] = Math.max(0, Math.min(255, Math.round(value)))
        cursor += 1
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A stable colour pair per product slug.
 *
 * Hashed rather than random so re-running the seed produces the same images and a
 * Lighthouse comparison across runs is measuring the code, not new bytes.
 */
export function coloursFor(slug: string): { inner: Rgb; outer: Rgb } {
  let hash = 0
  for (const character of slug) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return { inner: hslToRgb(hash, 0.55, 0.72), outer: hslToRgb((hash + 40) % 360, 0.5, 0.42) }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = l - c / 2
  return [
    Math.round(((r ?? 0) + m) * 255),
    Math.round(((g ?? 0) + m) * 255),
    Math.round(((b ?? 0) + m) * 255),
  ]
}
