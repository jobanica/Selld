import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { isLocale, persistLocale, SUPPORTED_LOCALES, type Locale } from './index'

export interface UseLocaleResult {
  locale: Locale
  setLocale: (next: Locale) => void
  toggleLocale: () => void
  locales: readonly Locale[]
}

/**
 * Read and change the active locale. The choice is persisted, so a seller who
 * picks Taglish once never has to pick it again.
 */
export function useLocale(): UseLocaleResult {
  const { i18n } = useTranslation()
  const current = isLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en'

  const setLocale = useCallback(
    (next: Locale) => {
      if (next === current) return
      void i18n.changeLanguage(next)
      persistLocale(next)
    },
    [current, i18n],
  )

  const toggleLocale = useCallback(() => {
    setLocale(current === 'en' ? 'tl' : 'en')
  }, [current, setLocale])

  return { locale: current, setLocale, toggleLocale, locales: SUPPORTED_LOCALES }
}
