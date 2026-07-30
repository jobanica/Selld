import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  CartQuote,
  CheckoutAddress,
  CheckoutContact,
  OrderReceipt,
  PsgcOptions,
  PsgcUnit,
} from '../src/storefront/cart-data'
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
  const back = safeReturnPath(body.get('return'))

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
        '/cart',
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
  return redirect(response, '/cart')
}

/**
 * `POST /checkout` — two intents on one route.
 *
 * `refresh` re-renders the form with the next address level populated. That exists
 * for the no-JavaScript path: a `<select>` cannot fetch on its own, so the buyer
 * taps a visible button and the server sends back a form with cities in it. With
 * JavaScript, the same options come from `/api/psgc` without a round trip, and this
 * intent is never used.
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
    redirect(response, '/cart')
    return { kind: 'redirect' }
  }

  // Resolve PSGC names server-side rather than trusting the ones the form posted.
  // The snapshot on the order has to say what the place is actually called, and a
  // crafted form could otherwise write "Barangay Anything" onto a real code.
  const named = await resolveAddressNames(supabase, address)

  let receipt: OrderReceipt
  try {
    receipt = await rpc<OrderReceipt>(supabase, 'checkout_place_order', {
      p_token: token,
      p_contact_name: contact.name,
      p_contact_phone: normalisePhPhone(contact.phone),
      p_address: named,
      p_payment_method: 'cod',
      p_contact_email: contact.email === '' ? null : contact.email,
      p_notes: contact.notes === '' ? null : contact.notes,
    })
  } catch (error) {
    if (error instanceof RpcError) {
      return { kind: 'render', contact, address, error: describeCheckoutError(error) }
    }
    throw error
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
  redirect(response, '/order/confirmed', cookies)
  return { kind: 'redirect' }
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

function safeReturnPath(value: string | null): string {
  // Only same-origin absolute paths. Reflecting an arbitrary value here would turn
  // the cart into an open redirect.
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return '/cart'
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
