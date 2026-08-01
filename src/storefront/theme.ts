import type { Store } from './storefront-data'

/**
 * Turning a seller's branding into CSS.
 *
 * The done-when for this phase is that a store "looks legitimately branded, not
 * templated". That is mostly this file: the brand colour has to reach the real
 * design tokens, and it has to do so in the server-rendered HTML so there is no
 * flash of the default green before the seller's colour lands.
 */

const HEX = /^#[0-9a-fA-F]{6}$/

/** Selld's default, used when a store has set no colour of its own. */
const DEFAULT_PRIMARY = '#3b3fe0'

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ]
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Text colour that is actually readable on top of `background`.
 *
 * Without this, a seller who picks a pale yellow gets white text on it — an
 * unreadable "Add to cart" button, which is the one control the whole page
 * exists to deliver. Picks whichever of near-white/near-black contrasts more,
 * rather than thresholding on luminance, because that is what the ratio
 * actually asks.
 */
export function readableForeground(background: string): string {
  const light = '#ffffff'
  const dark = '#101828'
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark
}

/**
 * Darken for hover/active states, in sRGB.
 *
 * Deliberately naive — a proper perceptual darken needs oklch, and shipping a
 * colour-space conversion to every buyer to compute a hover state is not a
 * trade worth making on a 3G budget.
 */
function shade(hex: string, amount: number): string {
  const scaled = channels(hex).map((c) => Math.round(Math.max(0, Math.min(1, c * amount)) * 255))
  return `#${scaled.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Seller-chosen fonts map to *system* stacks, never to a webfont.
 *
 * A Google Fonts link is two extra round trips (CSS, then the font file) on the
 * critical path, and it is the single easiest way to miss an LCP budget on a 3G
 * connection. A store that renders instantly in a system serif looks more
 * legitimate than one that renders in 3.5 seconds in Playfair Display.
 */
const FONT_STACKS: Record<string, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
}

export interface ResolvedTheme {
  primary: string
  primaryForeground: string
  primaryHover: string
  accent: string
  headlineFont: string
  bodyFont: string
}

export function resolveTheme(store: Store): ResolvedTheme {
  const themeColors = store.theme.colors ?? {}
  // `colors.primary` is the phase 2 theme editor; `brand_color` is the earlier
  // onboarding field. Prefer the more specific one, fall back, then default.
  const primary = isHexColor(themeColors.primary)
    ? themeColors.primary
    : isHexColor(store.brandColor)
      ? store.brandColor
      : DEFAULT_PRIMARY

  const accent = isHexColor(themeColors.accent) ? themeColors.accent : primary

  const fonts = store.theme.fonts ?? {}
  const headlineKey = typeof fonts.headline === 'string' ? fonts.headline : 'sans'
  const bodyKey = typeof fonts.body === 'string' ? fonts.body : 'sans'

  return {
    primary,
    primaryForeground: readableForeground(primary),
    primaryHover: shade(primary, 0.88),
    accent,
    headlineFont: FONT_STACKS[headlineKey] ?? FONT_STACKS.sans!,
    bodyFont: FONT_STACKS[bodyKey] ?? FONT_STACKS.sans!,
  }
}

/**
 * Strip anything that could break out of a `<style>` element.
 *
 * `custom_css` is seller-authored and goes into the page verbatim, so a literal
 * `</style>` in it would end the element and let the rest be parsed as HTML —
 * turning a CSS field into script injection on the store's own origin. It is
 * the seller's own store, but from phase 6 that origin also handles a buyer's
 * name, phone and address at checkout, so this is not self-inflicted-only.
 */
export function sanitizeCustomCss(css: string | null | undefined): string {
  if (typeof css !== 'string' || css.trim() === '') return ''

  let out = css.slice(0, 20_000)

  // Repeat until stable, because a single pass can *create* the very sequence it
  // just removed. `</sty</stylele` contains one `</style` at index 5; deleting it
  // joins the surrounding text into `</style`, which a one-shot replace would
  // then emit verbatim. Looping closes that.
  for (let pass = 0; pass < 20; pass += 1) {
    const next = out
      .replace(/<\/\s*style/gi, '')
      // HTML comment delimiters can also affect how a style element's contents
      // are tokenised.
      .replace(/<!--/g, '')
      .replace(/-->/g, '')
    if (next === out) return out
    out = next
  }

  // Pathological input that keeps regenerating a terminator. Twenty passes is far
  // more than any real stylesheet needs, so anything still changing here is an
  // attempt at exactly this bypass — drop it rather than emit a partial result.
  return ''
}

/**
 * The theme as a `<style>` body, inlined into the server-rendered head.
 *
 * These override the tokens in index.css, so every existing utility class
 * (`bg-primary`, `text-primary`, `ring-primary`) picks up the seller's colour
 * without the components knowing anything about theming.
 *
 * The selector is `html:root`, not `:root`, and that is deliberate. index.css
 * declares the same custom properties on `:root`, so with equal specificity the
 * winner is whichever stylesheet comes last — and in dev that is never ours:
 * Vite injects the app's CSS by appending a <style> element at runtime, so it
 * always lands after anything the server wrote into the document. Ordering the
 * tags correctly fixes production and still leaves every dev session rendering
 * in Selld's default green.
 *
 * `html:root` adds an element selector for a specificity of (0,1,1) against
 * `:root`'s (0,1,0), so the seller's colour wins on merit rather than on
 * position. It also beats index.css's `.dark` block, which is correct here: a
 * buyer's OS dark-mode preference should not repaint a seller's brand colour.
 */
export function themeStyleSheet(store: Store): string {
  const theme = resolveTheme(store)
  return [
    'html:root{',
    `--primary:${theme.primary};`,
    `--primary-foreground:${theme.primaryForeground};`,
    `--primary-hover:${theme.primaryHover};`,
    `--accent-brand:${theme.accent};`,
    `--ring:${theme.primary};`,
    `--font-headline:${theme.headlineFont};`,
    `--font-body:${theme.bodyFont};`,
    '}',
    'body{font-family:var(--font-body);}',
    '.font-headline{font-family:var(--font-headline);}',
    sanitizeCustomCss(store.theme.customCss),
  ].join('')
}
