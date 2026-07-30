/**
 * Philippine phone number normalisation.
 *
 * Phone number *is* the customer identity in PH social commerce — sellers have a
 * name and a number, rarely an email. `customers.phone` is the dedupe key, the
 * SMS destination, and the join target for buyer risk flags, so every number
 * entering the system gets normalised to E.164 (`+639171234567`) exactly once,
 * here.
 *
 * Sellers and buyers type numbers every imaginable way:
 *   09171234567  0917-123-4567  (0917) 123 4567  +63 917 123 4567
 *   639171234567  00639171234567  9171234567
 *
 * Numbering plan facts this relies on:
 *   - Mobile national significant numbers (NSN) are 10 digits starting with 9.
 *   - Landline NSNs are 9 digits: area code (1-2 digits) + subscriber digits.
 *     Metro Manila is area code 2 + 8 digits; everywhere else is 2 digits + 7.
 */

export type PhPhoneKind = 'mobile' | 'landline'

export interface PhPhone {
  /** E.164, the canonical storage form: `+639171234567`. */
  e164: string
  /** National significant number, no trunk prefix: `9171234567`. */
  nsn: string
  kind: PhPhoneKind
  /** Landline area code (`2`, `32`, `82`), or `null` for mobile. */
  areaCode: string | null
  /** How a Filipino reads it back: `0917 123 4567` / `(02) 8123 4567`. */
  national: string
}

export type PhPhoneError =
  | 'empty'
  | 'invalid_characters'
  | 'not_philippine'
  | 'unrecognised_length'
  | 'unknown_area_code'

/** Valid PH landline area codes (NDD codes), excluding Metro Manila's `2`. */
const LANDLINE_AREA_CODES = new Set([
  '32', '33', '34', '35', '36', '38', // Visayas
  '42', '43', '44', '45', '46', '47', '48', '49', // South/Central Luzon
  '52', '53', '54', '55', '56', // Bicol
  '62', '63', '64', '65', '68', // Western/Northern Mindanao
  '72', '74', '75', '77', '78', // Northern Luzon
  '82', '83', '84', '85', '86', '87', '88', // Davao / Southern Mindanao
])

const METRO_MANILA_AREA_CODE = '2'

/**
 * Parse and normalise. Returns `null` when the input is not a usable PH number —
 * use {@link parsePhPhoneDetailed} when you need to tell the user *why*.
 */
export function parsePhPhone(raw: string | null | undefined): PhPhone | null {
  const result = parsePhPhoneDetailed(raw)
  return result.ok ? result.phone : null
}

export type PhPhoneResult =
  | { ok: true; phone: PhPhone }
  | { ok: false; error: PhPhoneError }

export function parsePhPhoneDetailed(raw: string | null | undefined): PhPhoneResult {
  if (raw === null || raw === undefined) return { ok: false, error: 'empty' }

  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'empty' }

  // Keep digits, and a single leading +. Everything else (spaces, dashes,
  // parentheses, dots, a stray "tel:") is formatting noise.
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (digits === '') return { ok: false, error: 'invalid_characters' }

  // A + anywhere other than the front means we are guessing at the user's
  // intent; reject rather than mangle.
  if (trimmed.slice(1).includes('+')) return { ok: false, error: 'invalid_characters' }

  for (const candidate of nsnCandidates(digits, hasPlus)) {
    const phone = classifyNsn(candidate)
    if (phone) return { ok: true, phone }
  }

  // Explicitly international but not +63.
  if (hasPlus && !digits.startsWith('63')) return { ok: false, error: 'not_philippine' }

  // A 9-digit candidate that failed classification is an area-code problem;
  // anything else is a length problem. This drives a more useful error message.
  const stripped = stripPrefixes(digits)
  if (stripped.length === 9) return { ok: false, error: 'unknown_area_code' }
  return { ok: false, error: 'unrecognised_length' }
}

/**
 * Candidate NSNs, most-specific first. Each is validated by the caller, so an
 * ambiguous input resolves to the first interpretation that is actually a valid
 * PH number.
 *
 * The ambiguity that matters: `63XXXXXXX` is a valid 9-digit Iligan/Lanao
 * landline, and `63` is also the country code. Validating before committing
 * means we only strip `63` when what remains is itself valid.
 */
function nsnCandidates(digits: string, hasPlus: boolean): string[] {
  if (hasPlus) {
    // An explicit + means the country code is present and unambiguous.
    return digits.startsWith('63') ? [digits.slice(2)] : []
  }

  const candidates: string[] = []
  if (digits.startsWith('0063')) candidates.push(digits.slice(4))
  if (digits.startsWith('63')) candidates.push(digits.slice(2))
  if (digits.startsWith('0')) candidates.push(digits.replace(/^0+/, ''))
  candidates.push(digits)
  return candidates
}

function stripPrefixes(digits: string): string {
  if (digits.startsWith('0063')) return digits.slice(4)
  if (digits.startsWith('63')) return digits.slice(2)
  if (digits.startsWith('0')) return digits.replace(/^0+/, '')
  return digits
}

function classifyNsn(nsn: string): PhPhone | null {
  // Mobile: 10 digits, always starts with 9.
  if (/^9\d{9}$/.test(nsn)) {
    return {
      e164: `+63${nsn}`,
      nsn,
      kind: 'mobile',
      areaCode: null,
      national: `0${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}`,
    }
  }

  // Landline: 9 digits total.
  if (/^\d{9}$/.test(nsn)) {
    // Metro Manila: area code 2 + 8 subscriber digits.
    if (nsn.startsWith(METRO_MANILA_AREA_CODE)) {
      const subscriber = nsn.slice(1)
      return {
        e164: `+63${nsn}`,
        nsn,
        kind: 'landline',
        areaCode: METRO_MANILA_AREA_CODE,
        national: `(0${METRO_MANILA_AREA_CODE}) ${subscriber.slice(0, 4)} ${subscriber.slice(4)}`,
      }
    }

    // Elsewhere: 2-digit area code + 7 subscriber digits.
    const areaCode = nsn.slice(0, 2)
    if (LANDLINE_AREA_CODES.has(areaCode)) {
      const subscriber = nsn.slice(2)
      return {
        e164: `+63${nsn}`,
        nsn,
        kind: 'landline',
        areaCode,
        national: `(0${areaCode}) ${subscriber.slice(0, 3)} ${subscriber.slice(3)}`,
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** E.164 string for storage, or `null` if unparseable. */
export function normalizePhPhone(raw: string | null | undefined): string | null {
  return parsePhPhone(raw)?.e164 ?? null
}

/** Display form. Falls back to the raw input so we never blank out a seller's data. */
export function formatPhPhone(raw: string | null | undefined): string {
  const parsed = parsePhPhone(raw)
  if (parsed) return parsed.national
  return (raw ?? '').trim()
}

export function isValidPhPhone(raw: string | null | undefined): boolean {
  return parsePhPhone(raw) !== null
}

/** Only mobiles can receive SMS — gate tracking notifications on this. */
export function isPhMobile(raw: string | null | undefined): boolean {
  return parsePhPhone(raw)?.kind === 'mobile'
}

/**
 * Partially mask a number for display in shared contexts (packer views, risk
 * flags, exports): `0917 123 4567` -> `0917 •••• 4567`.
 */
export function maskPhPhone(raw: string | null | undefined): string {
  const parsed = parsePhPhone(raw)
  if (!parsed) return ''
  if (parsed.kind === 'mobile') {
    return `0${parsed.nsn.slice(0, 3)} •••• ${parsed.nsn.slice(6)}`
  }
  return `(0${parsed.areaCode}) •••• ${parsed.nsn.slice(-4)}`
}
