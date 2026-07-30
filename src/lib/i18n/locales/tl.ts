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
  auth: {
    signInTitle: 'Mag-sign in sa Selld',
    signInSubtitle: 'Ite-text o iemail namin ang 6-digit code. Walang password na tatandaan.',
    useMobile: 'Mobile number',
    useEmail: 'Email',
    mobileLabel: 'Mobile number',
    mobilePlaceholder: '0917 123 4567',
    emailLabel: 'Email address',
    emailPlaceholder: 'ikaw@example.com',
    sendCode: 'Ipadala ang code',
    sending: 'Pinapadala…',
    codeTitle: 'Ilagay ang code',
    codeSentTo: 'Pinadala namin ang 6-digit code sa {{destination}}.',
    codeLabel: '6-digit code',
    verify: 'Mag-sign in',
    verifying: 'Nag-sign in…',
    resend: 'Magpadala ng panibagong code',
    changeDestination: 'Gumamit ng ibang number o email',
    signOut: 'Mag-sign out',
    invalidEmail: 'Maglagay ng tamang email address.',
    invalidPhone: 'Maglagay ng tamang Philippine mobile number.',
    landlineNotAllowed: 'Mobile number lang ang makakatanggap ng code.',
    invalidCode: 'Ilagay ang 6-digit code.',
    unconfigured: 'Hindi pa naka-setup ang Supabase. Kopyahin ang .env.example sa .env.local.',
  },
  tenant: {
    yourStores: 'Mga store mo',
    switchStore: 'Palitan ang store',
    noStoreTitle: 'Gawin ang store mo',
    noStoreBody: 'Naka-sign in ka na. I-setup ang store mo para makapagsimula.',
    nameLabel: 'Pangalan ng store',
    namePlaceholder: "Rhea's Finds",
    slugLabel: 'Address ng store',
    slugHint: 'Letra, numero at gitling. Ito ang magiging link ng store mo.',
    slugTaken: 'May gumagamit na ng address na iyan.',
    slugInvalid: 'Gumamit ng 3–63 characters: letra, numero at gitling.',
    slugReserved: 'Reserved ang address na iyan. Pumili ng iba.',
    createStore: 'Gawin ang store',
    creating: 'Ginagawa…',
    role: {
      owner: 'Owner',
      admin: 'Admin',
      staff: 'Staff',
      packer: 'Packer',
      rider: 'Rider',
    },
  },
  invite: {
    title: 'Sumali sa store sa Selld',
    body: 'Inimbita ka para tumulong sa isang store. I-accept para sumali sa team.',
    accept: 'I-accept ang invitation',
    accepting: 'Sumasali…',
    accepted: 'Sali ka na. Welcome sa team.',
    wrongEmail: 'Ibang email address ang pinadalhan ng invitation. Mag-sign in gamit iyon.',
    expired: 'Expired na ang invitation. Magpahingi ng bago.',
    alreadyAccepted: 'Nagamit na ang invitation na ito.',
    notFound: 'Hindi namin makita ang invitation na iyan.',
  },
  errors: {
    unexpected: 'May mali sa nangyari.',
    notFound: 'Hindi makita ang page.',
    notFoundBody: 'Wala sa Selld ang page na hinahanap mo.',
    backToDashboard: 'Bumalik sa dashboard',
  },
}
