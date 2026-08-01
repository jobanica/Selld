import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'

import { qrPath } from './qr'

/**
 * The QR code is decoded, not merely rendered.
 *
 * A QR that is subtly wrong looks exactly like a QR that is right. The seller
 * finds out at the bazaar, after printing two hundred of them, and there is no
 * error anywhere in the stack — so the only test worth having is one that puts a
 * real decoder on the other end. `jsqr` is a devDependency and reaches no bundle.
 *
 * Verified to fail: shortening every horizontal run by one module makes all four
 * cases decode to `null`.
 */

/** Rasterise the shipped path — runs and all — the way the SVG draws it. */
function rasterise(value: string, scale = 8): { data: Uint8ClampedArray; px: number } {
  const { size, margin, d } = qrPath(value)
  const px = size * scale
  // White page, opaque.
  const data = new Uint8ClampedArray(px * px * 4).fill(255)

  // `M{x} {y}h{run}v1h-{run}z` — one rectangle per horizontal run of dark modules.
  const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)]
  for (const [, xRaw, yRaw, runRaw] of runs) {
    const x0 = Number(xRaw) + margin
    const y0 = Number(yRaw) + margin
    for (let k = 0; k < Number(runRaw); k += 1) {
      for (let y = y0 * scale; y < (y0 + 1) * scale; y += 1) {
        for (let x = (x0 + k) * scale; x < (x0 + k + 1) * scale; x += 1) {
          const index = (y * px + x) * 4
          data[index] = 0
          data[index + 1] = 0
          data[index + 2] = 0
        }
      }
    }
  }

  return { data, px }
}

describe('qrPath', () => {
  it.each([
    // The path-mounted form, which is what selld.vercel.app serves today.
    'https://selld.vercel.app/store/rheas-finds',
    // The subdomain form, for when a real domain is pointed at it.
    'https://rheas-finds.selld.ph',
    // The shortest slug the validator allows, and a long one — the encoder picks
    // a bigger version for the second, and version selection is a thing to get
    // wrong.
    'https://selld.vercel.app/store/a',
    `https://selld.vercel.app/store/${'x'.repeat(48)}`,
  ])('scans back to %s', (value) => {
    const { data, px } = rasterise(value)
    expect(jsQR(data, px, px)?.data).toBe(value)
  })

  it('leaves a quiet zone on every side', () => {
    const { size, margin, d } = qrPath('https://selld.ph')
    const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)/g)]
    expect(runs.length).toBeGreaterThan(0)
    for (const [, x, y, run] of runs) {
      expect(Number(y) + margin).toBeLessThan(size - margin)
      expect(Number(x) + margin + Number(run)).toBeLessThanOrEqual(size - margin)
    }
  })
})
