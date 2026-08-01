import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  CartQuote,
  CheckoutAddress,
  CheckoutContact,
  OrderReceipt,
  PsgcOptions,
  PsgcUnit,
} from '../src/storefront/cart-data'
import { isOnlineMethod } from '../src/storefront/cart-data'
import { storeHref } from '../src/lib/tenant/resolve-tenant'
import {
  appendSetCookie,
  CART_COOKIE,
  cartCookie,
  checkoutCookie,
  clearCartCookie,
  isSecureRequest,
  parseCookies,
  readRememberedCheckout,
} from './cookies'
import { notifyOrderPlaced } from './order-notifications'
import { readServiceConfig } from './payment-webhook'
import { startOnlinePayment } from './payment-start'
import { clientIp } from './rate-limit'
import { rpc, RpcError, type SupabaseConfig } from './supabase-rpc'

/**
 * Cart and checkout, over HTTP.
 *
 * Every mutation is a real form POST followed by a 303 redirect, not a JSON API
 * call. That is a deliberate continuation of phase 5's decision: the storefront has
 * to work before its JavaScript arrives, and "add to cart" is the one interaction a
 * buyer will try first. A `fetch`-only cart would sit dead until hydration
 * finished, which on a 3G connection is exactly when an impatient buyer taps.
 *
 * POST-then-redirect also means reloading the cart page never re-submits, and the
 * browser's back button behaves.
 *
 * CSRF: the cart cookie is `SameSite=Lax`, so a cross-site POST arrives without it
 * and cannot act on anyone's cart. No state-changing route is reachable by GET.
 */

const MAX_BODY_BYTES = 16 * 1024

export interface StoreRef {
  slug: string | null
  domain: string | null
  /**
   * Where this store is mounted on the host, e.g. `/store/rhea`. Empty for the
   * subdomain and custom-domain forms, where the store owns the whole origin.
   * Carried here because every redirect out of a cart route is a link back into
   * the shop, and a bare `/cart` under a path mount leaves it.
   */
  basePath: string
}

/** Read and parse an `application/x-www-form-urlencoded` body. */
export async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    // A checkout form is a few hundred bytes. Anything past 16KB is not a buyer.
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(buffer)
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The absolute origin of this request, for provider return URLs.
 *
 * Built from the forwarded proto and host rather than a configured base URL,
 * because a store can be reached on `{slug}.selld.ph` or on its own custom domain
 * and the buyer must come back to the one they left from. Same reasoning as
 * `isSecureRequest` — deriving from the request is what makes both work behind a
 * proxy and in local development without a second code path.
 */
function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto']
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() ??
    (isSecureRequest(request) ? 'https' : 'http')
  const host = request.headers.host ?? 'localhost'
  return `${proto}://${host}`
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    Location: location,
    // 303 rather than 302: the follow-up must be a GET even though this was a
    // POST, or a reload re-submits the form.
    'Cache-Control': 'no-store',
  }
  if (cookies.length > 0) headers['Set-Cookie'] = cookies
  response.writeHead(303, headers)
  response.end()
}

/**
 * The cart token for this request, minting one only when something is being added.
 *
 * A browsing visitor must not get a cart row — otherwise every crawler hit creates
 * one and the table fills with empty carts that abandoned-cart recovery would
 * later try to email.
 */
async function resolveCartToken(
  supabase: SupabaseConfig,
  request: IncomingMessage,
  store: StoreRef,
  options: { create: boolean },
): Promise<{ token: string | null; setCookie: string | null }> {
  const cookies = parseCookies(request)
  const existing = cookies[CART_COOKIE]

  if (existing !== undefined && /^[0-9a-f]{64}$/.test(existing)) {
    return { token: existing, setCookie: null }
  }
  if (!options.create) return { token: null, setCookie: null }

  const token = await rpc<string>(supabase, 'cart_create', {
    p_slug: store.slug,
    p_domain: store.domain,
  })
  return { token, setCookie: cartCookie(token, isSecureRequest(request)) }
}

export async function fetchQuote(
  supabase: SupabaseConfig,
  token: string | null,
  paymentMethod = 'cod',
): Promise<CartQuote | null> {
  if (token === null) return null
  return rpc<CartQuote | null>(supabase, 'cart_view', {
    p_token: token,
    p_payment_method: paymentMethod,
  })
}

/**
 * The quote for a known destination.
 *
 * Used by the checkout page as soon as the buyer has picked a city, so the shipping
 * line stops being the catch-all estimate the cart page showed. It calls the same
 * `cart_pricing` the order will, with the same arguments — which is what keeps the
 * number on screen and the number charged identical. Falls back to the
 * address-less quote while the cascade is still incomplete.
 */
export async function fetchQuoteForAddress(
  supabase: SupabaseConfig,
  token: string | null,
  address: Partial<CheckoutAddress>,
  paymentMethod = 'cod',
): Promise<CartQuote | null> {
  if (token === null) return null
  if ((address.cityCode ?? '') === '') return fetchQuote(supabase, token, paymentMethod)

  return rpc<CartQuote | null>(supabase, 'cart_quote_for_address', {
    p_token: token,
    p_region_code: address.regionCode ?? null,
    p_province_code: (address.provinceCode ?? '') === '' ? null : address.provinceCode,
    p_city_code: address.cityCode,
    p_payment_method: paymentMethod,
  })
}

export async function fetchReceipt(
  supabase: SupabaseConfig,
  token: string | null,
): Promise<OrderReceipt | null> {
  if (token === null) return null
  return rpc<OrderReceipt | null>(supabase, 'order_receipt_for_token', { p_token: token })
}

/** `POST /cart/add` — variantId + qty, then back where the buyer came from. */
export async function handleCartAdd(
  request: IncomingMessage,
  response: ServerResponse,
  supabase: SupabaseConfig,
  store: StoreRef,
): Promise<void> {
  const body = await readFormBody(request)
  const variantId = body.get('variantId') ?? ''
  const qty = Number.parseInt(body.get('qty') ?? '1', 10)
  const back = safeReturnPath(body.get('return'), store.basePath)

  if (!/^[0-9a-f-]{36}$/i.test(variantId)) return redirect(response, back)

  const { token, setCookie } = await resolveCartToken(supabase, request, store, { create: true })
  const cookies = setCookie === null ? [] : [setCookie]

  try {
    await rpc(supabase, 'cart_add_item', {
      p_token: token,
      p_variant_id: variantId,
      p_qty: Number.isFinite(qty) ? qty : 1,
    })
  } catch (error) {
    // A stale cookie pointing at a converted or expired cart is the common case —
    // the buyer just checked out. Start them a fresh cart rather than showing an
    // error for something they did not do wrong.
    if (error instanceof RpcError) {
      const retry = await rpc<string>(supabase, 'cart_create', {
        p_slug: store.slug,
        p_domain: store.domain,
      })
      await rpc(supabase, 'cart_add_item', {
        p_token: retry,
        p_variant_id: variantId,
        p_qty: Number.isFinite(qty) ? qty : 1,
      })
      return redirect(
        response,
        storeHref(store.basePath, '/cart'),
        appendSetCookie(undefined, cartCookie(retry, isSecureRequest(request))),
      )
    }
    throw error
  }

  return redirect(response, back, cookies)
}

/** `POST /cart/qty` — set an exact quantity; 0 removes the line. */
export async function handleCartQty(
  request: IncomingMessage,
  response: ServerResponse,
  supabase: SupabaseConfig,
  store: StoreRef,
): Promise<void> {
  const body = await readFormBody(request)
  const variantId = body.get('variantId') ?? ''
  const qty = Number.parseInt(body.get('qty') ?? '0', 10)
  const { token } = await resolveCartToken(supabase, request, store, { create: false })

  if (token !== null && /^[0-9a-f-]{36}$/i.test(variantId)) {
    try {
      await rpc(supabase, 'cart_set_qty', {
        p_token: token,
        p_variant_id: variantId,
        p_qty: Number.isFinite(qty) ? qty : 0,
      })
    } catch (error) {
      if (!(error instanceof RpcError)) throw error
      // Cart gone; the redirect below will render an empty cart, which is true.
    }
  }
  return redirect(response, storeHref(store.basePath, '/cart'))
}

/**
 * `POST /checkout` — two intents on one route.
 *
 * `refresh` re-renders the form with the next address level populated. Without
 * JavaScript a `<select>` cannot submit on its own, so the buyer taps a visible
 * button; once hydrated the select calls `requestSubmit` with that same button. Both
 * paths take this identical round trip — the trigger is enhanced, not the fetch, so
 * there is one code path to be correct.
 *
 * `place` is the real thing.
 *
 * The form is POSTed rather than GETed even for `refresh`, so a name, phone number
 * and street never end up in a URL, browser history, or a referer header.
 */
export async function handleCheckoutPost(
  request: IncomingMessage,
  response: ServerResponse,
  supabase: SupabaseConfig,
  store: StoreRef,
): Promise<
  | { kind: 'redirect' }
  | {
      kind: 'render'
      contact: CheckoutContact
      address: Partial<CheckoutAddress>
      error: { field: string; message: string } | null
    }
> {
  const body = await readFormBody(request)
  const intent = body.get('intent') ?? 'place'

  const contact: CheckoutContact = {
    name: (body.get('name') ?? '').trim().slice(0, 120),
    phone: (body.get('phone') ?? '').trim().slice(0, 20),
    email: (body.get('email') ?? '').trim().slice(0, 160),
    notes: (body.get('notes') ?? '').trim().slice(0, 500),
  }

  const address: Partial<CheckoutAddress> = {
    regionCode: (body.get('regionCode') ?? '').trim(),
    provinceCode: (body.get('provinceCode') ?? '').trim() || null,
    cityCode: (body.get('cityCode') ?? '').trim(),
    barangayCode: (body.get('barangayCode') ?? '').trim(),
    street: (body.get('street') ?? '').trim().slice(0, 200),
    landmark: (body.get('landmark') ?? '').trim().slice(0, 200),
    postalCode: (body.get('postalCode') ?? '').trim().slice(0, 8),
  }

  if (intent === 'refresh') {
    return { kind: 'render', contact, address, error: null }
  }

  const { token } = await resolveCartToken(supabase, request, store, { create: false })
  if (token === null) {
    redirect(response, storeHref(store.basePath, '/cart'))
    return { kind: 'redirect' }
  }

  // Resolve PSGC names server-side rather than trusting the ones the form posted.
  // The snapshot on the order has to say what the place is actually called, and a
  // crafted form could otherwise write "Barangay Anything" onto a real code.
  const named = await resolveAddressNames(supabase, address)

  // The method the buyer chose, validated against the closed set rather than
  // forwarded. `checkout_place_order` re-checks it and refuses an online method
  // when the store has no enabled account, so this is a narrowing, not the
  // enforcement.
  const posted = (body.get('paymentMethod') ?? 'cod').trim()
  const paymentMethod = posted === 'cod' || isOnlineMethod(posted) ? posted : 'cod'

  let receipt: OrderReceipt
  try {
    receipt = await rpc<OrderReceipt>(supabase, 'checkout_place_order', {
      p_token: token,
      p_contact_name: contact.name,
      p_contact_phone: normalisePhPhone(contact.phone),
      p_address: named,
      p_payment_method: paymentMethod,
      p_contact_email: contact.email === '' ? null : contact.email,
      p_notes: contact.notes === '' ? null : contact.notes,
    })
  } catch (error) {
    if (error instanceof RpcError) {
      return { kind: 'render', contact, address, error: describeCheckoutError(error) }
    }
    throw error
  }

  /**
   * Online payment: open the charge and hand the buyer to the provider.
   *
   * The order already exists and stock is already reserved, which is the right way
   * round — reserving only after payment would let two buyers pay for the last
   * unit. If the provider call fails, `startOnlinePayment` returns null and the
   * buyer still lands on their confirmation page with an unpaid order they can
   * retry, rather than losing the order to a bad minute at Xendit.
   */
  // Recorded whichever way the box was left, and *after* the order exists —
  // there is no customer row to attach it to before then. Safe to order that way
  // round precisely because the order does not depend on it: see the phase-20
  // migration header.
  await recordConsent(request, token, receipt.id, body.get('marketingConsent') === 'yes')

  if (paymentMethod !== 'cod') {
    const started = await startOnlinePayment({
      supabase,
      cartToken: token,
      orderId: receipt.id,
      method: paymentMethod,
      origin: requestOrigin(request),
    })

    const cookies = appendSetCookie(
      undefined,
      checkoutCookie({ ...contact, ...named }, isSecureRequest(request)),
    )
    // No confirmation SMS yet: an online order is not confirmed until it is paid,
    // and texting "we got your order" before the buyer has paid trains them to
    // ignore the one that says it went through.
    redirect(response, started?.checkoutUrl ?? storeHref(store.basePath, '/order/confirmed'), cookies)
    return { kind: 'redirect' }
  }

  // Confirmation SMS. Awaited rather than fired and forgotten, because on a
  // serverless host the process can be frozen the moment the response is written
  // and a detached promise would simply never run. It is cheap (one provider call)
  // and it cannot fail the order — see `notifyOrderPlaced`.
  await notifyOrderPlaced(supabase, token, receipt)

  // Remember the details for next time — from this browser only. The cart cookie
  // is kept so the confirmation page can read the receipt; the cart itself is
  // already `converted`, so nothing can be added to it.
  const cookies = appendSetCookie(
    undefined,
    checkoutCookie({ ...contact, ...named }, isSecureRequest(request)),
  )
  redirect(response, storeHref(store.basePath, '/order/confirmed'), cookies)
  return { kind: 'redirect' }
}

/**
 * Write the marketing grant, with the evidence a regulator would ask for.
 *
 * The IP is *hashed*, not stored. An IP address is personal data under the DPA,
 * and a consent log that is itself a privacy problem is a poor joke — the hash is
 * enough to show two grants came from the same place, which is all the evidence
 * needs to do.
 *
 * Never allowed to fail the checkout. The order is already placed and the buyer's
 * stock is already reserved; throwing here would turn a successful purchase into
 * a 500 over a checkbox.
 */
async function recordConsent(
  request: IncomingMessage,
  token: string,
  orderId: string,
  granted: boolean,
): Promise<void> {
  const service = readServiceConfig()
  if (service === null) return

  const ip = clientIp(request)
  try {
    await rpc(service, 'record_checkout_consent', {
      p_token: token,
      p_order_id: orderId,
      p_granted: granted,
      p_policy_version: await policyVersion(service),
      p_evidence: {
        surface: 'storefront',
        ipHash: createHash('sha256').update(ip).digest('hex').slice(0, 32),
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
      },
    })
  } catch {
    /* A checkbox must never cost a buyer their order. */
  }
}

/**
 * The version of the policy the buyer was shown.
 *
 * Asked of the database rather than hard-coded here, because a grant recorded
 * against a version string this file happens to hold is a grant to a document
 * nobody can prove was on the page.
 */
let cachedPolicyVersion: string | null = null
async function policyVersion(service: SupabaseConfig): Promise<string> {
  if (cachedPolicyVersion !== null) return cachedPolicyVersion
  try {
    cachedPolicyVersion = await rpc<string>(service, 'privacy_policy_version', {})
  } catch {
    cachedPolicyVersion = 'unknown'
  }
  return cachedPolicyVersion
}

/** Map a Postgres error onto the field the buyer needs to fix. */
function describeCheckoutError(error: RpcError): { field: string; message: string } {
  const text = error.message.toLowerCase()
  if (text.includes('contact_name')) return { field: 'contact_name', message: 'name' }
  if (text.includes('contact_phone')) return { field: 'contact_phone', message: 'phone' }
  if (text.includes('address_incomplete')) {
    return { field: 'address_incomplete', message: 'address' }
  }
  if (text.includes('empty_cart')) return { field: 'empty_cart', message: 'empty' }
  if (text.includes('insufficient stock') || text.includes('insufficient_stock')) {
    return { field: 'other', message: 'stock' }
  }
  if (text.includes('cod_disabled') || text.includes('payment_method_unavailable')) {
    return { field: 'other', message: 'payment' }
  }
  if (text.includes('no_location')) return { field: 'other', message: 'store' }
  return { field: 'other', message: 'unknown' }
}

/**
 * Normalise a typed phone number to +63 E.164.
 *
 * Duplicated deliberately rather than importing `src/lib/phone`: that module is a
 * full parser with landline classification, and the server only needs the one
 * shape the database will accept. `checkout_place_order` re-validates with a CHECK
 * regex, so a miss here is a rejected form and not a bad row.
 */
function normalisePhPhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, '')
  if (digits.startsWith('+63')) return digits
  if (digits.startsWith('63')) return `+${digits}`
  if (digits.startsWith('0')) return `+63${digits.slice(1)}`
  if (digits.startsWith('9') && digits.length === 10) return `+63${digits}`
  return input.trim()
}

function safeReturnPath(value: string | null, basePath: string): string {
  // Only same-origin absolute paths. Reflecting an arbitrary value here would turn
  // the cart into an open redirect.
  const fallback = storeHref(basePath, '/cart')
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return fallback
  // And under a path mount, only paths inside *this* store. Same-origin is no
  // longer the whole test once several shops share a host: a posted `return` of
  // `/store/someone-else` would bounce the buyer into a different seller's shop
  // mid-purchase, carrying their cart cookie with them.
  if (basePath !== '' && value !== basePath && !value.startsWith(`${basePath}/`)) return fallback
  return value.slice(0, 300)
}

// ---------------------------------------------------------------------------
// PSGC
// ---------------------------------------------------------------------------

/**
 * Options for whichever cascade levels the buyer has reached.
 *
 * Fetched through PostgREST with the anon key, same as everything else the
 * storefront reads. PSGC is public reference data with a read-only policy.
 */
export async function fetchPsgcOptions(
  supabase: SupabaseConfig,
  address: Partial<CheckoutAddress>,
): Promise<PsgcOptions> {
  const regions = await selectPsgc(supabase, 'psgc_regions', 'code,name', {})

  const provinces =
    (address.regionCode ?? '') === ''
      ? []
      : await selectPsgc(supabase, 'psgc_provinces', 'code,name', {
          region_code: `eq.${address.regionCode}`,
        })

  // NCR has no province, and 19 cities carry `province_code is null`. So cities are
  // looked up by province when there is one and by region when there is not —
  // this is the cascade shortcut the whole address module exists to encapsulate.
  const cities =
    (address.regionCode ?? '') === ''
      ? []
      : (address.provinceCode ?? '') !== ''
        ? await selectPsgc(supabase, 'psgc_cities', 'code,display_name', {
            province_code: `eq.${address.provinceCode}`,
          })
        : provinces.length === 0
          ? await selectPsgc(supabase, 'psgc_cities', 'code,display_name', {
              region_code: `eq.${address.regionCode}`,
              province_code: 'is.null',
            })
          : []

  const barangays =
    (address.cityCode ?? '') === ''
      ? []
      : await selectPsgc(supabase, 'psgc_barangays', 'code,name', {
          city_code: `eq.${address.cityCode}`,
        })

  return { regions, provinces, cities, barangays }
}

async function selectPsgc(
  supabase: SupabaseConfig,
  table: string,
  columns: string,
  filters: Record<string, string>,
): Promise<PsgcUnit[]> {
  const params = new URLSearchParams({ select: columns, order: columns.split(',')[1] ?? 'name' })
  for (const [key, value] of Object.entries(filters)) params.set(key, value)

  const response = await fetch(`${supabase.url}/rest/v1/${table}?${params.toString()}`, {
    headers: {
      apikey: supabase.anonKey,
      Authorization: `Bearer ${supabase.anonKey}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new RpcError(table, response.status, await response.text())

  const rows = (await response.json()) as Record<string, string>[]
  return rows.map((row) => ({
    code: row.code ?? '',
    // psgc_cities exposes `display_name` ("Davao City") because the canonical PSA
    // value is "City of Davao"; every other level uses `name`.
    name: row.display_name ?? row.name ?? '',
  }))
}

/** Fill in the human names for a set of PSGC codes, from the database. */
async function resolveAddressNames(
  supabase: SupabaseConfig,
  address: Partial<CheckoutAddress>,
): Promise<CheckoutAddress> {
  const lookups = await Promise.all([
    lookupOne(supabase, 'psgc_regions', 'code,name', address.regionCode),
    lookupOne(supabase, 'psgc_provinces', 'code,name', address.provinceCode ?? ''),
    lookupOne(supabase, 'psgc_cities', 'code,display_name', address.cityCode),
    lookupOne(supabase, 'psgc_barangays', 'code,name', address.barangayCode),
  ])

  // Spread-when-present rather than assigning `undefined`: with
  // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
  // absent key, and the absent key is what belongs in the JSON snapshot.
  return {
    regionCode: address.regionCode ?? '',
    ...(lookups[0] === null ? {} : { regionName: lookups[0].name }),
    provinceCode: address.provinceCode ?? null,
    provinceName: lookups[1]?.name ?? null,
    cityCode: address.cityCode ?? '',
    ...(lookups[2] === null ? {} : { cityName: lookups[2].name }),
    barangayCode: address.barangayCode ?? '',
    ...(lookups[3] === null ? {} : { barangayName: lookups[3].name }),
    ...(address.street === undefined || address.street === '' ? {} : { street: address.street }),
    ...(address.landmark === undefined || address.landmark === ''
      ? {}
      : { landmark: address.landmark }),
    ...(address.postalCode === undefined || address.postalCode === ''
      ? {}
      : { postalCode: address.postalCode }),
  }
}

async function lookupOne(
  supabase: SupabaseConfig,
  table: string,
  columns: string,
  code: string | undefined,
): Promise<PsgcUnit | null> {
  if (code === undefined || code === '') return null
  const rows = await selectPsgc(supabase, table, columns, { code: `eq.${code}` })
  return rows[0] ?? null
}

export { clearCartCookie, parseCookies, readRememberedCheckout }
