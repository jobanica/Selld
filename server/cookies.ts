import type { IncomingMessage } from 'node:http'

/**
 * Cookies for the storefront.
 *
 * Two of them, with different jobs:
 *
 *   `selld_cart`     the cart token. A bearer credential — httpOnly, so no script
 *                    on the page can read it and no XSS can exfiltrate it.
 *   `selld_checkout` the buyer's last contact details and address, so a returning
 *                    buyer does not retype them.
 *
 * The second one deserves its reasoning written down. The phase brief asks for
 * "autofill for returning phone numbers", and the obvious implementation — look up
 * the phone number server-side and return the address on file — is an address
 * disclosure oracle: anyone could type a stranger's number into a public checkout
 * form and read back where they live. So autofill comes from the buyer's *own*
 * browser instead. It is strictly less capable (a new device retypes) and it is the
 * only version that does not hand out other people's addresses.
 *
 * Both are `SameSite=Lax`, which is also the CSRF defence for the POST routes: a
 * cross-site form submission does not carry a Lax cookie, so a hostile page cannot
 * place an order as somebody else. Nothing here is a state-changing GET.
 */

export const CART_COOKIE = 'selld_cart'
export const CHECKOUT_COOKIE = 'selld_checkout'

const CART_MAX_AGE = 60 * 60 * 24 * 30 // 30 days, matching carts.expires_at
const CHECKOUT_MAX_AGE = 60 * 60 * 24 * 180

export function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie
  if (header === undefined || header === '') return {}

  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name === '') continue
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      // A malformed percent-escape is not worth failing a page render over.
      out[name] = value
    }
  }
  return out
}

export interface CookieOptions {
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
}

/**
 * Whether this request arrived over TLS.
 *
 * The `Secure` flag is derived from the *request*, not from `NODE_ENV`. Keying it
 * on the environment looked right and was wrong in both directions:
 *
 *   * Running the production build locally (`pnpm start`, plain http) emitted
 *     Secure cookies that every client correctly refuses to store. The symptom is
 *     not an error — it is a cart that silently stays empty, an add-to-cart that
 *     "does nothing", and a checkout that redirects back to an empty cart. That
 *     cost real debugging time here.
 *   * A staging deploy running with NODE_ENV unset would have emitted cart cookies
 *     with no Secure flag over real https.
 *
 * `x-forwarded-proto` is the signal a TLS-terminating CDN or load balancer sets,
 * which is how this will actually be deployed; `socket.encrypted` covers serving
 * TLS directly. Trusting the header can only *add* Secure, never remove it.
 */
export function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true
  return (request.socket as { encrypted?: boolean }).encrypted === true
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax']
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.secure === true) parts.push('Secure')
  return parts.join('; ')
}

export function cartCookie(token: string, secure: boolean): string {
  return serializeCookie(CART_COOKIE, token, { maxAge: CART_MAX_AGE, secure })
}

/** Clear the cart cookie — after checkout, or when a token stops resolving. */
export function clearCartCookie(): string {
  return `${CART_COOKIE}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0`
}

export interface RememberedCheckout {
  name?: string
  phone?: string
  email?: string
  regionCode?: string
  regionName?: string
  provinceCode?: string | null
  provinceName?: string | null
  cityCode?: string
  cityName?: string
  barangayCode?: string
  barangayName?: string
  street?: string
  landmark?: string
  postalCode?: string
}

export function checkoutCookie(value: RememberedCheckout, secure: boolean): string {
  // Base64 so a comma or semicolon in a street name cannot break cookie parsing.
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  return serializeCookie(CHECKOUT_COOKIE, encoded, { maxAge: CHECKOUT_MAX_AGE, secure })
}

export function readRememberedCheckout(cookies: Record<string, string>): RememberedCheckout {
  const raw = cookies[CHECKOUT_COOKIE]
  if (raw === undefined || raw === '') return {}
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    if (parsed === null || typeof parsed !== 'object') return {}
    // Not validated field by field: every value is echoed into a form that the
    // buyer can see and correct, and checkout re-validates server-side anyway.
    // Treating it as authoritative is what would be wrong.
    return parsed as RememberedCheckout
  } catch {
    return {}
  }
}

/**
 * Append a `Set-Cookie`, preserving any already queued.
 *
 * `response.setHeader('Set-Cookie', …)` replaces rather than appends, so setting
 * the cart cookie and the checkout cookie in one response silently drops the
 * first one.
 */
export function appendSetCookie(existing: string | string[] | undefined, cookie: string): string[] {
  if (existing === undefined) return [cookie]
  return Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]
}
