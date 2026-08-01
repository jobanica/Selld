import { describe, expect, it } from 'vitest'

import type { Store } from './storefront-data'
import {
  contrastRatio,
  readableForeground,
  resolveTheme,
  sanitizeCustomCss,
  themeStyleSheet,
} from './theme'

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 't1',
    name: 'Rhea’s Finds',
    slug: 'rheas-finds',
    customDomain: null,
    logoPath: null,
    brandColor: null,
    locale: 'en',
    theme: {},
    ...overrides,
  }
}

describe('readableForeground()', () => {
  it('puts dark text on a pale brand colour', () => {
    // The failure this prevents: a seller picks pastel yellow, gets white text,
    // and "Add to cart" becomes invisible — the one control the page exists for.
    expect(readableForeground('#fde68a')).toBe('#101828')
  })

  it('puts light text on a dark brand colour', () => {
    expect(readableForeground('#12604f')).toBe('#ffffff')
  })

  it('always clears WCAG AA for large text', () => {
    const colours = ['#ffffff', '#000000', '#b0245f', '#fde68a', '#12604f', '#7c3aed', '#22d3ee']
    for (const colour of colours) {
      const ratio = contrastRatio(colour, readableForeground(colour))
      expect(ratio, `${colour} -> ${readableForeground(colour)}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('resolveTheme()', () => {
  it('prefers the theme editor colour over the onboarding brand colour', () => {
    const resolved = resolveTheme(
      store({ brandColor: '#111111', theme: { colors: { primary: '#b0245f' } } }),
    )
    expect(resolved.primary).toBe('#b0245f')
  })

  it('falls back to brand_color, then to the Selld default', () => {
    expect(resolveTheme(store({ brandColor: '#b0245f' })).primary).toBe('#b0245f')
    expect(resolveTheme(store()).primary).toBe('#3b3fe0')
  })

  it('ignores a malformed colour rather than emitting broken CSS', () => {
    // The database validates this, but a theme row predating that trigger — or a
    // future import path — could still carry junk. An invalid custom property
    // makes every use of it fall back to nothing, i.e. an unstyled store.
    const resolved = resolveTheme(store({ theme: { colors: { primary: 'red; }' } } }))
    expect(resolved.primary).toBe('#3b3fe0')
  })

  it('never resolves a font to a webfont URL', () => {
    // A Google Fonts request is two round trips on the critical path and the
    // easiest way to miss the LCP budget.
    const resolved = resolveTheme(store({ theme: { fonts: { headline: 'serif' } } }))
    expect(resolved.headlineFont).not.toMatch(/https?:|url\(/)
    expect(resolved.headlineFont).toContain('Georgia')
  })

  it('falls back for an unknown font key', () => {
    const resolved = resolveTheme(store({ theme: { fonts: { headline: 'Comic Papyrus' } } }))
    expect(resolved.headlineFont).toContain('system-ui')
  })
})

describe('sanitizeCustomCss()', () => {
  it('strips a closing style tag', () => {
    // Without this, seller-authored CSS can end the <style> element and inject
    // script on the store's own origin — which from phase 6 also handles a
    // buyer's name, phone and address.
    //
    // The property asserted is the absence of `</style`, NOT the absence of the
    // string "<script". Inside a style element nothing but `</style` terminates
    // parsing, so a leftover "<script>" is inert CSS text — and CSS can contain
    // it legitimately, e.g. `content: "<script>"`. Asserting on "<script" would
    // demand a sanitiser stricter than the actual boundary requires.
    const dirty = 'body{color:red}</style><script>alert(1)</script>'
    expect(sanitizeCustomCss(dirty)).not.toMatch(/<\/\s*style/i)
  })

  it('cannot be bypassed by making the removal rebuild the terminator', () => {
    // A single global replace is not enough. This input contains exactly one
    // `</style` (at index 5); deleting it joins `</sty` to `le`, producing a
    // brand-new `</style` that a one-pass sanitiser would emit verbatim — and
    // the injection lands.
    const rebuilt = '</sty</stylele>'
    expect(rebuilt).toMatch(/<\/\s*style/i)
    expect(rebuilt.replace(/<\/\s*style/gi, '')).toMatch(/<\/\s*style/i)
    expect(sanitizeCustomCss(rebuilt)).not.toMatch(/<\/\s*style/i)
  })

  it('strips it however it is spelled', () => {
    for (const attempt of ['</style>', '</ style>', '</STYLE>', '</StYlE  >']) {
      expect(sanitizeCustomCss(`a{}${attempt}b`), attempt).not.toMatch(/<\/\s*style/i)
    }
  })

  it('strips HTML comment delimiters', () => {
    expect(sanitizeCustomCss('a{}<!-- -->')).not.toContain('<!--')
  })

  it('keeps ordinary CSS intact', () => {
    expect(sanitizeCustomCss('.hero{background:#fff;font-size:2rem}')).toBe(
      '.hero{background:#fff;font-size:2rem}',
    )
  })

  it('returns empty for nothing', () => {
    expect(sanitizeCustomCss(null)).toBe('')
    expect(sanitizeCustomCss('   ')).toBe('')
  })

  it('caps the length', () => {
    expect(sanitizeCustomCss('a'.repeat(50_000)).length).toBe(20_000)
  })
})

describe('themeStyleSheet()', () => {
  it('outranks index.css instead of relying on source order', () => {
    // index.css declares these on `:root`. Equal specificity means source order
    // decides, and in dev Vite appends the app stylesheet at runtime — after
    // anything the server wrote — so a `:root` selector here loses every time and
    // the store renders in Selld green.
    const sheet = themeStyleSheet(store({ brandColor: '#b0245f' }))
    expect(sheet.startsWith('html:root{')).toBe(true)
  })

  it('emits the brand colour and a readable foreground together', () => {
    const sheet = themeStyleSheet(store({ theme: { colors: { primary: '#fde68a' } } }))
    expect(sheet).toContain('--primary:#fde68a')
    expect(sheet).toContain('--primary-foreground:#101828')
  })

  it('carries sanitized custom CSS through', () => {
    const sheet = themeStyleSheet(
      store({ theme: { customCss: '.hero{border:0}</style><script>x()</script>' } }),
    )
    expect(sheet).toContain('.hero{border:0}')
    // Again: no terminator, therefore no escape. See sanitizeCustomCss above.
    expect(sheet).not.toMatch(/<\/\s*style/i)
  })
})
