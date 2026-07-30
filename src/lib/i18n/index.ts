import i18next, { type TFunction } from 'i18next'
import { initReactI18next } from 'react-i18next'

import { en } from './locales/en'
import { tl } from './locales/tl'

/**
 * The `t` function's type, for helpers that take it as a parameter.
 *
 * Typing such a parameter as `(key: string) => string` looks harmless but throws
 * away the key checking that makes a typo a compile error, and TypeScript rejects
 * the assignment anyway because the real signature is narrower.
 */
export type Translate = TFunction<'common'>

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

/**
 * An isolated i18next instance, for server rendering.
 *
 * {@link initI18n} configures the shared singleton, which is right in a browser
 * — one user, one locale, set once. It is wrong on a server: the `initialised`
 * guard means the *first* request's locale would silently apply to every later
 * one, so one Taglish store would render every English store in Taglish until
 * the process restarted.
 *
 * Each render gets its own instance instead. `initAsync: false` makes
 * initialisation synchronous, which it must be — `renderToString` cannot await.
 * (The option was `initImmediate` before i18next v21; it is `initAsync` now, and
 * passing the old name is silently ignored rather than rejected at runtime.)
 */
export function createI18nInstance(locale: Locale) {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  })
  return instance
}

export { i18next }
