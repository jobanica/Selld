import { fromDb, type Centavos } from '@/lib/money'

import type { Store } from './storefront-data'

/**
 * Cart and checkout read models — the shapes `cart_pricing()` and
 * `order_receipt()` return.
 *
 * Same constraint as `storefront-data.ts`: no Node-only and no DOM-only imports,
 * because the server renderer and the hydrated client both use this.
 */

export interface CartLine {
  variantId: string
  productId: string
  productName: string
  productSlug: string
  variantLabel: string | null
  sku: string | null
  qty: number
  /** Live price, read from the database. What the buyer will actually pay. */
  unitPrice: number
  lineTotal: number
  /** Price when the line was added. For messaging only — never charged. */
  snapshotPrice: number
  priceChanged: boolean
  inStock: boolean
  image: string | null
  renditions: number[]
}

/**
 * A priced cart.
 *
 * Every number here came from `cart_pricing()`. Nothing in the client computes a
 * total — not even for display — because a total computed in two places is a total
 * that eventually disagrees with itself, and the version the buyer saw is the one
 * they will argue about.
 */
export interface CartQuote {
  cartId: string
  paymentMethod: string
  itemCount: number
  items: CartLine[]
  subtotal: number
  discountTotal: number
  shippingTotal: number
  codFee: number
  grandTotal: number
}

export interface OrderReceipt {
  id: string
  orderNumber: string
  placedAt: string
  contactName: string
  contactPhone: string
  address: CheckoutAddress
  paymentMethod: string
  paymentStatus: string
  status: string
  subtotal: number
  discountTotal: number
  shippingTotal: number
  codFee: number
  grandTotal: number
  notes: string | null
  store: { name: string; slug: string }
  items: {
    productName: string
    variantLabel: string | null
    sku: string | null
    qty: number
    unitPrice: number
    lineTotal: number
  }[]
}

/**
 * The address as it is snapshotted onto an order.
 *
 * Codes *and* names. Codes are what phase 7's shipping zones and phase 10's
 * courier booking match on; names are what the order must still say in six months
 * when PSA has renamed something and a courier is disputing a delivery.
 *
 * `provinceCode` is optional and that is not an oversight — NCR and three
 * independent cities have no province at all.
 */
export interface CheckoutAddress {
  regionCode: string
  regionName?: string
  provinceCode?: string | null
  provinceName?: string | null
  cityCode: string
  cityName?: string
  barangayCode: string
  barangayName?: string
  street?: string
  landmark?: string
  postalCode?: string
}

/** Contact details, echoed back into the form when a checkout is re-rendered. */
export interface CheckoutContact {
  name: string
  phone: string
  email: string
  notes: string
}

export const EMPTY_CONTACT: CheckoutContact = { name: '', phone: '', email: '', notes: '' }

export interface CheckoutFieldError {
  field: 'contact_name' | 'contact_phone' | 'address_incomplete' | 'empty_cart' | 'other'
  message: string
}

/**
 * Cart-family pages.
 *
 * Each carries `store` because these pages are reached by cookie rather than by a
 * catalog query, so there is no payload to take branding from — and an unbranded
 * cart reads as having left the shop.
 */
export type CartPageData =
  | { route: 'cart'; store: Store | null; quote: CartQuote | null }
  | {
      route: 'checkout'
      store: Store | null
      quote: CartQuote | null
      contact: CheckoutContact
      address: CheckoutAddress | Partial<CheckoutAddress>
      /** PSGC options for whatever level the buyer has reached. */
      options: PsgcOptions
      error: CheckoutFieldError | null
    }
  | { route: 'order-confirmed'; store: Store | null; receipt: OrderReceipt }

export interface PsgcUnit {
  code: string
  name: string
}

export interface PsgcOptions {
  regions: PsgcUnit[]
  provinces: PsgcUnit[]
  cities: PsgcUnit[]
  barangays: PsgcUnit[]
}

export const EMPTY_PSGC_OPTIONS: PsgcOptions = {
  regions: [],
  provinces: [],
  cities: [],
  barangays: [],
}

/** Brand a centavo amount from the payload before it can reach a formatter. */
export function money(value: number | null | undefined): Centavos {
  return fromDb(value ?? 0)
}

/**
 * Whether an address has everything a courier needs.
 *
 * Region, city and barangay. Province is deliberately absent from this list — see
 * `CheckoutAddress`. Street is not required either: plenty of PH addresses are a
 * landmark and a barangay, which is exactly why `landmark` exists as a field.
 */
export function isDeliverable(address: Partial<CheckoutAddress>): boolean {
  return (
    (address.regionCode ?? '') !== '' &&
    (address.cityCode ?? '') !== '' &&
    (address.barangayCode ?? '') !== ''
  )
}

/**
 * Which cascade level still needs a choice, or null when the address is complete.
 *
 * Drives both the no-JS "next" button and the JS fetch, so the two cannot
 * disagree about what the buyer is being asked for.
 */
export function nextAddressLevel(
  address: Partial<CheckoutAddress>,
  options: PsgcOptions,
): 'region' | 'province' | 'city' | 'barangay' | null {
  if ((address.regionCode ?? '') === '') return 'region'
  // NCR has no provinces at all, so an empty province list means "skip this
  // level", not "the buyer has not chosen yet".
  if ((address.cityCode ?? '') === '') {
    return options.provinces.length > 0 && (address.provinceCode ?? '') === ''
      ? 'province'
      : 'city'
  }
  if ((address.barangayCode ?? '') === '') return 'barangay'
  return null
}
