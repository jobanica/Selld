/**
 * The online payment vocabulary, in one place.
 *
 * These five strings are a contract with three parties that cannot see each
 * other: the `payments.methods` setting a seller edits, the
 * `storefront_payment_methods()` whitelist in SQL, and the checkout page a buyer
 * picks from. The union used to live in `src/storefront/cart-data.ts`, which made
 * it storefront-shaped — and the settings catalogue could not reach it without
 * the dashboard importing buyer code. Same list, somewhere both can see it.
 */

export type OnlineMethod = 'gcash' | 'maya' | 'grabpay' | 'qrph' | 'card'

/**
 * Order matters: it is the order the buttons appear in at checkout, and GCash
 * first is not a preference — it is the wallet most Filipino buyers have.
 */
export const ONLINE_METHODS: readonly OnlineMethod[] = [
  'gcash',
  'maya',
  'grabpay',
  'qrph',
  'card',
]

export function isOnlineMethod(value: string): value is OnlineMethod {
  return (ONLINE_METHODS as readonly string[]).includes(value)
}
