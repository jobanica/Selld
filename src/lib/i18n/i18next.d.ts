import type { Translations } from './locales/en'

/**
 * Makes `t('nav.orders')` autocomplete and `t('nav.typo')` a compile error.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: {
      common: Translations
    }
    returnNull: false
  }
}
