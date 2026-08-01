import { useMemo } from 'react'

import { qrPath } from '@/lib/qr'

/**
 * A QR code for a store link, drawn as SVG rectangles.
 *
 * Sellers print this on a receipt, tape it to a booth at a bazaar, and paste it
 * into a Facebook post — which is why it renders as vector rather than a canvas:
 * the same component is legible at 120px on a phone and at A4 on a tarpaulin, and
 * a browser's print dialog rasterises it at the printer's DPI rather than the
 * screen's. `downloadQrPng()` covers the other half, where the destination is an
 * app that wants a file.
 *
 * Black on white, ignoring the store's brand colour. A tinted QR is the classic
 * way to make one that a phone in a dim bazaar aisle cannot read, and this code
 * exists to be scanned in exactly that lighting.
 */
export function StoreQr({
  value,
  className,
  title,
}: {
  value: string
  className?: string
  /** Accessible name. The code is a link, so say where it goes. */
  title: string
}) {
  const { size, margin, d } = useMemo(() => qrPath(value), [value])

  return (
    <svg
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className={className}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" transform={`translate(${String(margin)}, ${String(margin)})`} />
    </svg>
  )
}
