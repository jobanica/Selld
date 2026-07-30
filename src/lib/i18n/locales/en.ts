/**
 * English source strings. This object is the schema — `tl.ts` is typed against
 * it, so adding a key here without translating it is a compile error.
 */
export const en = {
  app: {
    name: 'Selld',
    tagline: 'The online store built for Filipino social sellers.',
  },
  nav: {
    sectionMain: 'Main',
    sectionSell: 'Sell',
    sectionGrow: 'Grow',
    dashboard: 'Dashboard',
    orders: 'Orders',
    products: 'Products',
    inventory: 'Inventory',
    customers: 'Customers',
    liveSelling: 'Live selling',
    inbox: 'Inbox',
    shipping: 'Shipping',
    analytics: 'Analytics',
    settings: 'Settings',
  },
  common: {
    loading: 'Loading…',
    save: 'Save',
    cancel: 'Cancel',
    search: 'Search',
    comingSoon: 'Coming soon',
    retry: 'Try again',
    close: 'Close',
    menu: 'Menu',
  },
  locale: {
    label: 'Language',
    en: 'English',
    tl: 'Taglish',
    switchTo: 'Switch to {{language}}',
  },
  dashboard: {
    title: 'Dashboard',
    welcome: 'Welcome to Selld',
    foundationNotice:
      'Foundation is in place. Storefront, orders, and inventory arrive in the phases ahead.',
    metricCommissionKept: 'Commission kept this month',
    metricCommissionKeptHint: 'What you would have paid a marketplace on the same sales.',
    metricOrders: 'Orders',
    metricRevenue: 'Revenue',
    metricAwaitingPacking: 'Awaiting packing',
  },
  errors: {
    unexpected: 'Something went wrong.',
    notFound: 'Page not found.',
    notFoundBody: 'The page you are looking for does not exist.',
    backToDashboard: 'Back to dashboard',
  },
}

/**
 * Deliberately not `as const`: widening the values to `string` is what lets
 * `tl.ts` be typed as `Translations` and still hold different text. Key paths
 * are still inferred from the structure, so `t()` stays autocompleted.
 */
export type Translations = typeof en
