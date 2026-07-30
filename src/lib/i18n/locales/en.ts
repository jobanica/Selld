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
  auth: {
    signInTitle: 'Sign in to Selld',
    signInSubtitle: 'We will text or email you a 6-digit code. No password to remember.',
    useMobile: 'Mobile number',
    useEmail: 'Email',
    mobileLabel: 'Mobile number',
    mobilePlaceholder: '0917 123 4567',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    sendCode: 'Send code',
    sending: 'Sending…',
    codeTitle: 'Enter your code',
    codeSentTo: 'We sent a 6-digit code to {{destination}}.',
    codeLabel: '6-digit code',
    verify: 'Sign in',
    verifying: 'Signing in…',
    resend: 'Send another code',
    changeDestination: 'Use a different number or email',
    signOut: 'Sign out',
    invalidEmail: 'Enter a valid email address.',
    invalidPhone: 'Enter a valid Philippine mobile number.',
    landlineNotAllowed: 'Only mobile numbers can receive a code.',
    invalidCode: 'Enter the 6-digit code.',
    unconfigured: 'Supabase is not configured yet. Copy .env.example to .env.local.',
  },
  tenant: {
    yourStores: 'Your stores',
    switchStore: 'Switch store',
    noStoreTitle: 'Create your store',
    noStoreBody: 'You are signed in. Set up your store to get started.',
    nameLabel: 'Store name',
    namePlaceholder: "Rhea's Finds",
    slugLabel: 'Store address',
    slugHint: 'Letters, numbers and hyphens. This becomes your store link.',
    slugTaken: 'That address is already taken.',
    slugInvalid: 'Use 3–63 characters: letters, numbers and hyphens.',
    slugReserved: 'That address is reserved. Please pick another.',
    createStore: 'Create store',
    creating: 'Creating…',
    role: {
      owner: 'Owner',
      admin: 'Admin',
      staff: 'Staff',
      packer: 'Packer',
      rider: 'Rider',
    },
  },
  invite: {
    title: 'Join a store on Selld',
    body: 'You have been invited to help run a store. Accept to join the team.',
    accept: 'Accept invitation',
    accepting: 'Joining…',
    accepted: 'You are in. Welcome to the team.',
    wrongEmail: 'This invitation was sent to a different email address. Sign in with that one.',
    expired: 'This invitation has expired. Ask for a new one.',
    alreadyAccepted: 'This invitation has already been used.',
    notFound: 'We could not find that invitation.',
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
