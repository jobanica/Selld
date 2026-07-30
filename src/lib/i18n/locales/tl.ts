import type { Translations } from './en'

/**
 * Taglish — not formal Tagalog.
 *
 * Sellers say "orders," "inventory," "customers," and "dashboard" in English
 * even mid-Tagalog sentence. Translating those into deep Tagalog ("talaan ng
 * mga paninda") reads as machine-translated and costs us credibility with the
 * exact person we are selling to. Keep the loanwords, translate the connective
 * tissue and anything with feeling in it.
 *
 * Typed as `Translations`, so this file cannot drift out of sync with `en.ts`.
 */
export const tl: Translations = {
  app: {
    name: 'Selld',
    tagline: 'Ang online store na gawa para sa Pinoy social sellers.',
  },
  nav: {
    sectionMain: 'Pangunahin',
    sectionSell: 'Magbenta',
    sectionGrow: 'Palakihin',
    dashboard: 'Dashboard',
    orders: 'Mga Order',
    products: 'Mga Produkto',
    inventory: 'Stocks',
    customers: 'Mga Customer',
    liveSelling: 'Live Selling',
    inbox: 'Inbox',
    shipping: 'Shipping',
    analytics: 'Analytics',
    settings: 'Settings',
  },
  common: {
    loading: 'Naglo-load…',
    save: 'I-save',
    cancel: 'Cancel',
    search: 'Maghanap',
    comingSoon: 'Malapit na',
    retry: 'Subukan muli',
    close: 'Isara',
    menu: 'Menu',
  },
  locale: {
    label: 'Lengguwahe',
    en: 'English',
    tl: 'Taglish',
    switchTo: 'Palitan sa {{language}}',
  },
  dashboard: {
    title: 'Dashboard',
    welcome: 'Welcome sa Selld',
    foundationNotice:
      'Nakaayos na ang pundasyon. Susunod na ang storefront, orders, at inventory.',
    metricCommissionKept: 'Commission na naiwan sa bulsa mo',
    metricCommissionKeptHint: 'Ito ang bayad mo sana sa marketplace sa parehong sales.',
    metricOrders: 'Mga Order',
    metricRevenue: 'Kita',
    metricAwaitingPacking: 'Hindi pa naipa-pack',
  },
  errors: {
    unexpected: 'May mali sa nangyari.',
    notFound: 'Hindi makita ang page.',
    notFoundBody: 'Wala sa Selld ang page na hinahanap mo.',
    backToDashboard: 'Bumalik sa dashboard',
  },
}
