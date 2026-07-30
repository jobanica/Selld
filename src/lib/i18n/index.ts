import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import { en } from './locales/en'
import { tl } from './locales/tl'

export const SUPPORTED_LOCALES = ['en', 'tl'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'selld.locale'

/** Native label for each locale, shown in the switcher. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  tl: 'Taglish',
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Resolve the starting locale: an explicit past choice wins, then the browser's
 * preference, then English.
 *
 * `fil` and `tl` both appear in the wild for Filipino, and Android reports
 * `fil-PH`, so match on prefix rather than exact tag.
 */
export function detectLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // Private browsing / disabled storage — fall through to browser detection.
  }

  const preferences = window.navigator.languages ?? [window.navigator.language]
  for (const preference of preferences) {
    const tag = preference.toLowerCase()
    if (tag.startsWith('tl') || tag.startsWith('fil')) return 'tl'
    if (tag.startsWith('en')) return 'en'
  }
  return DEFAULT_LOCALE
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Not fatal — the locale still applies for this session.
  }
}

export const resources = {
  en: { common: en },
  tl: { common: tl },
} as const

let initialised = false

export function initI18n(locale: Locale = detectLocale()) {
  if (initialised) return i18next

  void i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: 'common',
    ns: ['common'],
    interpolation: {
      // React already escapes rendered values.
      escapeValue: false,
    },
    returnNull: false,
  })

  initialised = true
  return i18next
}

export { i18next }
