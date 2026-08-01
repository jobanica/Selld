/**
 * Take the people out of an error report before it leaves the process.
 *
 * This exists because the default behaviour of every error-tracking SDK is
 * wrong for this product. They capture the URL, the request headers, the cookies
 * and often the form body — and in Selld those carry a buyer's phone number,
 * their address, a cart token that *is* their session, and in the seller's case a
 * courier API key. An error report containing those is a personal-data breach we
 * mailed ourselves, with a copy on somebody else's servers, and phase 20 has a
 * table for logging exactly that.
 *
 * So nothing is sent that has not been through here first, and the rule is
 * deny-by-shape rather than deny-by-list: a value that *looks* like a phone
 * number is redacted wherever it appears, including inside a message somebody
 * wrote by hand, because the list of places a phone number can turn up is not
 * knowable in advance.
 *
 * The cost is over-redaction — an order number that happens to be eleven digits
 * gets masked too. That is the correct direction to be wrong in.
 */

/** PH mobile in any of the forms this codebase handles, plus generic E.164. */
const PH_PHONE = /(?:\+?63|0)9\d{9}\b|\+\d{10,15}\b/g
const EMAIL = /[^\s@,;<>()[\]{}"']+@[^\s@,;<>()[\]{}"']+\.[a-z]{2,}/gi
/** A cart token, a webhook secret, an invitation token: 32+ bytes as hex. */
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi
/** A JWT, which is what an access token looks like on this platform. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
/** `sk_live_…`, `xnd_…`, and the rest of the provider key shapes. */
const PROVIDER_KEY = /\b(?:sk|pk|rk|xnd)_[A-Za-z0-9_-]{8,}\b/g

/**
 * Keys whose *value* is never safe, whatever it looks like.
 *
 * Shape-matching catches a phone number in free text; this catches the ones with
 * no recognisable shape — a street address is just words.
 */
const UNSAFE_KEYS =
  /^(?:street|address|shipping_?address|landmark|recipient|contact_?name|full_?name|buyer_?name|phone|mobile|email|token|secret|password|authorization|cookie|api_?key|access_?token|refresh_?token|callback_?token|credentials?|credentials_encrypted)$/i

/*
 * Note what is *not* on that list: a bare `name`. A courier is called `jnt`, a
 * product is called "Rosehip Serum", a store is called "Rhea's Finds" — none of
 * them is a person, and redacting all of them to protect `contact_name` would
 * leave a report that says an unknown thing failed for an unknown reason. Over-
 * redaction is the right direction to be wrong in, and it is still possible to
 * be wrong in it far enough to be useless.
 */

export const REDACTED = '[redacted]'

/** Mask anything that looks like a person or a secret, wherever it appears. */
export function scrubText(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(PROVIDER_KEY, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(PH_PHONE, REDACTED)
}

/**
 * A URL with its query stripped to keys.
 *
 * `?phone=09171234567` is the obvious case and `/track/0042` is the subtle one:
 * an order number is a capability on this platform, so the path is scrubbed for
 * shapes too, and the query keeps its *names* — which is the part that helps
 * debugging — while dropping every value.
 */
export function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw, 'http://placeholder.invalid')
    const keys = [...url.searchParams.keys()]
    const query = keys.length === 0 ? '' : `?${keys.map((key) => `${key}=`).join('&')}`
    return `${scrubText(url.pathname)}${query}`
  } catch {
    return scrubText(raw)
  }
}

/**
 * Deep-scrub an arbitrary value.
 *
 * Depth-limited and breadth-limited: an error payload that recurses or carries a
 * ten-thousand-element array is one that would cost more to serialise than the
 * information is worth, and a cycle would hang the process trying to report a
 * crash.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = UNSAFE_KEYS.test(key) ? REDACTED : scrub(item, depth + 1)
    }
    return out
  }
  // Functions, symbols, undefined: nothing to report and nothing safe to guess.
  return undefined
}
