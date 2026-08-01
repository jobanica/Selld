/**
 * Generate the PWA icons.
 *
 *   pnpm pwa:icons
 *
 * Written as pixels rather than pulled from an image library, for the reason
 * `scripts/demo-images.ts` gives about PNG: the container is simple enough that a
 * dependency used by one build step is not worth the install. The mark is the
 * same shopping bag as `public/favicon.svg`, described here as geometry.
 *
 * Two variants, and the difference matters more than it looks:
 *
 *   **any** — the icon as drawn, edge to edge. What a desktop launcher shows.
 *   **maskable** — the same mark shrunk into the middle 60% of the canvas, on a
 *   full-bleed background. Android crops an installed icon to whatever shape the
 *   launcher uses (circle, squircle, teardrop), and a `purpose: any` icon put
 *   through that crop loses its corners. The safe zone is a circle of 40% radius;
 *   anything outside it is not guaranteed to survive.
 *
 * Committed to `public/` rather than generated at build time, because they are
 * product assets that ship, not fixtures.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

const BRAND: Rgb = [0x3b, 0x3f, 0xe0]
const INK: Rgb = [0xff, 0xff, 0xff]

type Rgb = readonly [number, number, number]

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

/**
 * Signed distance to a rounded rectangle. Negative inside, and — the part worth
 * getting right — *linear* just inside the edge, so `d > -w && d < 0` is a stroke
 * of width `w` all the way round.
 *
 * The first attempt clamped to the nearest corner centre and returned `-radius`
 * for anything in the middle, which drew the corners and dropped the straight
 * top and bottom edges entirely. It looked like a rendering bug and was a maths
 * one.
 */
function roundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): number {
  const dx = Math.abs(x - (left + right) / 2) - ((right - left) / 2 - radius)
  const dy = Math.abs(y - (top + bottom) / 2) - ((bottom - top) / 2 - radius)
  return (
    Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
  )
}

/**
 * The mark, sampled at 3× and averaged.
 *
 * Supersampling rather than an analytic anti-alias: the shapes are simple enough
 * that nine samples per pixel is both cheap and visibly smooth, and it avoids
 * having to get the coverage maths right for a stroke that curves.
 */
function iconPng(size: number, options: { maskable: boolean }): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let cursor = 0

  // The mark occupies the whole canvas for `any`, and the safe zone for
  // `maskable`. 0.6 keeps every stroke inside the 40%-radius circle Android
  // guarantees, with room for the launcher's own inset.
  const scale = options.maskable ? 0.6 : 0.86
  const inset = (1 - scale) / 2

  const sample = (px: number, py: number): Rgb => {
    // Normalised to the 0..1 mark space.
    const u = (px / size - inset) / scale
    const v = (py / size - inset) / scale

    // Background: the rounded square, or full bleed when maskable — a maskable
    // icon that leaves transparent corners gets them filled with the launcher's
    // own colour, which is nobody's brand.
    const bg = options.maskable ? true : roundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22) < 0
    if (!bg) return [0, 0, 0]

    // The bag body.
    const body = roundedRect(u, v, 0.21, 0.37, 0.79, 0.81, 0.06)
    const bodyStroke = body > -0.055 && body < 0
    // The handle: an annulus, upper half only.
    const r = Math.hypot(u - 0.5, v - 0.4)
    const handle = v < 0.4 && r > 0.145 && r < 0.2
    /*
     * The S, which is what the brand is built on and what a launcher icon has
     * to be recognisable by at 48 pixels. Two bowls: the upper keeps its top
     * and left, the lower keeps its bottom and right, and together they read as
     * the letter. It replaces the bag pocket that used to sit here — the pocket
     * said "bag", which the silhouette already says on its own.
     */
    const ring = (cx: number, cy: number, radius: number): number =>
      Math.abs(Math.hypot(u - cx, v - cy) - radius)
    const stroke = 0.028
    const upper = ring(0.5, 0.535, 0.075) < stroke && (v < 0.535 || u < 0.5)
    const lower = ring(0.5, 0.685, 0.075) < stroke && (v > 0.685 || u > 0.5)

    return bodyStroke || handle || upper || lower ? INK : BRAND
  }

  for (let y = 0; y < size; y += 1) {
    raw[cursor] = 0
    cursor += 1
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const [pr, pg, pb] = sample(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)
          r += pr
          g += pg
          b += pb
          hits += 1
        }
      }
      raw[cursor] = Math.round(r / hits)
      raw[cursor + 1] = Math.round(g / hits)
      raw[cursor + 2] = Math.round(b / hits)
      cursor += 3
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets: { file: string; size: number; maskable: boolean }[] = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS ignores the manifest and reads `apple-touch-icon`, at 180.
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
]

for (const target of targets) {
  const png = iconPng(target.size, { maskable: target.maskable })
  writeFileSync(join(PUBLIC_DIR, target.file), png)
  console.log(`${target.file}  ${target.size}×${target.size}  ${(png.length / 1024).toFixed(1)}KB`)
}
