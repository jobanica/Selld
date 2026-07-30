/**
 * Everything the storefront needs to agree on about images.
 *
 * These constants are shared by the components that render `<img>` and by the
 * server that emits the `<link rel="preload">` for the LCP image. They live in one
 * module because duplicating them is a silent, expensive bug: if a preload's
 * `imagesizes` disagrees with the element's `sizes`, the two can resolve to
 * different candidates, and the browser downloads both files and uses the second.
 */

/**
 * Width of the full-size original the upload path writes.
 *
 * A constant rather than a per-image column because every writer produces the
 * same size: the demo seed does, and phase 3's uploader will once it downscales.
 * If that stops being true this has to become data on `product_images`.
 */
export const NATURAL_IMAGE_WIDTH = 900

/** Grid cards: two columns on phones, three from sm, four from lg. */
export const CARD_IMAGE_SIZES = '(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw'

/**
 * Product page main image: full width on phones, half the container from sm up.
 *
 * `calc(100vw - 2rem)` rather than `100vw` because the gallery sits inside a
 * `px-4` container. Overstating the slot makes the browser select a larger
 * candidate than it will ever draw.
 */
export const PRODUCT_IMAGE_SIZES = '(min-width: 640px) min(50vw, 36rem), calc(100vw - 2rem)'

/**
 * `fetchpriority`, spelled so React 18 actually forwards it.
 *
 * React 19 knows the `fetchPriority` prop and lowercases it on the way to the
 * DOM. This project is pinned to React 18, which does not — and the failure is a
 * confusing one to read:
 *
 *   - `react-dom/server` writes the attribute out verbatim as `fetchPriority`.
 *     HTML attribute names are ASCII case-insensitive, so the browser honours it
 *     and the LCP hint does land on first parse.
 *   - `react-dom/client` does not recognise the camelCase prop, so hydration logs
 *     "React does not recognize the fetchPriority prop on a DOM element" for every
 *     image on the page.
 *
 * So it works by accident while filling the console with warnings that would hide
 * a real error. Passing the attribute already lowercased makes both renderers
 * agree: React forwards unknown *lowercase* attributes without complaint.
 *
 * `@types/react` v18 types the camelCase form only, which is why this returns its
 * own shape — it is describing a DOM attribute React has no opinion about, not
 * defeating a type check.
 */
export function priorityAttrs(priority: boolean): { fetchpriority?: 'high' } {
  // Only when high. `fetchpriority="auto"` is the default, so emitting it on every
  // lazy image below the fold is bytes for nothing.
  return priority ? { fetchpriority: 'high' } : {}
}
