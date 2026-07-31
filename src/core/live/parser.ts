/**
 * Reading a claim out of a live-selling comment.
 *
 * ## What this is for
 *
 * A seller holds up an item, says "A1 po ito", and thirty comments arrive in ten
 * seconds. Somebody currently types those into a notebook by hand and then into a
 * spreadsheet afterwards, and that transcription is where the evening's profit goes:
 * a missed claim is a lost sale, a mis-keyed one is a parcel sent to the wrong
 * person, and a double-entered one oversells stock that is not there.
 *
 * So this has one job and two failure modes that are not symmetric:
 *
 * - **A missed claim** costs a sale and the buyer usually re-comments.
 * - **A false claim** reserves stock that nobody is buying, which makes the item
 *   show sold out while the seller is still holding it, and every later buyer is
 *   turned away.
 *
 * The second is worse, so the parser is deliberately conservative: when a comment
 * is not clearly a claim, it is not a claim, and the operator console shows it as
 * unmatched rather than guessing.
 *
 * ## The rules, in the order they apply
 *
 * 1. **Tokenise, don't substring-match.** `nakuha ko` contains `kuha ko`, and
 *    `nakuha ko na po yung A1 kahapon` is a buyer talking about a *previous*
 *    purchase. Matching on whole tokens is what keeps that out.
 * 2. **A claim marker makes it a claim.** `mine`, `sakin`, `akoa`, `claim`, `kuha
 *    ko` and friends — including the Bisaya ones, because a Cebu or Davao seller
 *    gets most of their comments in Bisaya.
 * 3. **Without a marker, the comment must be nothing but codes, quantities and
 *    filler.** `A1`, `A1 2pcs`, `C5 po` are claims. `ang ganda ng A1` and `magkano
 *    po A1?` are not, and they are the entries that decide whether this parser is
 *    usable — a compliment that reserves stock is worse than no parser at all.
 * 4. **A named code that this session does not sell is never a fallback.** `mine
 *    Z9` is unmatched, not a claim on whatever happens to be on screen. The buyer
 *    said something specific; guessing past it sends the wrong item.
 * 5. **A bare marker claims what is on screen**, and nothing at all when nothing
 *    is being shown.
 *
 * Every one of those is exercised by `corpus.ts`, which was written before this
 * file and is scored as a whole in `parser.test.ts`.
 */

export interface ParsedClaim {
  code: string
  qty: number
}

export type ParseReason =
  | 'claimed'
  /** Nothing here reads as an order. */
  | 'not_a_claim'
  /** The buyer named a code this session does not sell. */
  | 'unknown_code'
  /** A bare "mine" with nothing on screen to claim. */
  | 'no_item_on_screen'

export interface ParseResult {
  claims: ParsedClaim[]
  reason: ParseReason
  /** Code-shaped tokens the session does not sell, for the operator to see. */
  unknownCodes: string[]
}

export interface ParseContext {
  /** Claim codes this session sells, in any case. */
  codes: readonly string[]
  /** What the seller has on screen right now, or null. */
  currentCode?: string | null
}

/**
 * The most anyone claims in one comment on a live sale.
 *
 * Above this, the number is something else the buyer typed — a price they are
 * repeating back (`A1 500 mine`), a phone number, a size. Capping rather than
 * trusting is what keeps a comment from reserving five hundred units and
 * blanking the item for everyone else.
 */
const MAX_QTY = 20

/**
 * Words that carry no meaning for a claim.
 *
 * These are what a comment is allowed to contain and still count as "nothing but
 * a code": politeness, linkers, and the noise around a number.
 */
const FILLER = new Set([
  'po', 'pu', 'opo', 'na', 'nap', 'lang', 'lng', 'nalang', 'din', 'rin', 'ba',
  'ng', 'nang', 'yung', 'yun', 'ung', 'ang', 'ako', 'at', 'and', 'tsaka',
  'saka', 'pati', 'plus', 'each', 'ate', 'sis', 'mam', 'maam', 'sir', 'idol',
  'thanks', 'salamat', 'ty', 'tnx', 'pcs', 'pc', 'pieces', 'piece', 'x',
  'ok', 'okay', 'sige', 'yes', 'oo', 'ha', 'ho', 'nya', 'niya', 'ni', 'no',
])

/** Claim markers. Tagalog, Bisaya and English, as sellers actually receive them. */
const MARKERS = new Set([
  'mine', 'mines', 'minee', 'miness', 'minez', 'myn', 'mien',
  'sakin', 'saakin', 'akin', 'aking', 'akina',
  'akoa', 'akoaa', 'akon', 'saako', 'akoni',
  'get', 'gets', 'claim', 'claims', 'claiming', 'claimed', 'reserve', 'reserved',
  'kuha', 'kunin', 'kuhaon', 'order',
])

/**
 * Two-token markers, matched after the single-token pass.
 *
 * `sa akin` and `sa ako` only mean "mine" together — `sa` alone is a preposition
 * and `ako` alone is the single most common word in a Tagalog comment thread.
 */
const MARKER_PAIRS = [
  ['sa', 'akin'],
  ['sa', 'ako'],
  ['ako', 'ni'],
  ['ako', 'na'],
  ['kuha', 'ko'],
  ['kunin', 'ko'],
  ['akin', 'na'],
  ['para', 'sakin'],
  ['pa', 'reserve'],
]

/** Number words, Tagalog / Bisaya / English, including the `-ng` linker forms. */
const NUMBER_WORDS: Record<string, number> = {
  isa: 1, isang: 1, usa: 1, usang: 1, one: 1, uno: 1,
  dalawa: 2, dalawang: 2, duha: 2, duhang: 2, two: 2, dos: 2,
  tatlo: 3, tatlong: 3, tulo: 3, tulong: 3, three: 3, tres: 3,
  apat: 4, apatna: 4, upat: 4, four: 4, kwatro: 4,
  lima: 5, limang: 5, five: 5, singko: 5,
  anim: 6, anum: 6, unom: 6, six: 6,
  pito: 7, pitong: 7, seven: 7,
  walo: 8, walong: 8, eight: 8,
  siyam: 9, siyam9: 9, nine: 9,
  sampu: 10, napulo: 10, ten: 10,
}

interface Token {
  /** Normalised text. */
  text: string
  kind: 'code' | 'qty' | 'marker' | 'filler' | 'content'
  /** For `code`, the canonical code; for `qty`, the number. */
  value?: string | number
}

/**
 * Fold a comment down to comparable tokens.
 *
 * Emoji, punctuation and diacritics go; case goes; the separators inside a code go
 * (`A-1`, `A.1` and `A 1` are all `A1` to the person typing them). What survives is
 * a list of words and numbers.
 */
function normalise(text: string): string {
  return text
    .normalize('NFKD')
    // Strip combining marks, then anything that is not a letter, a digit or a space.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Join a code split across tokens.
 *
 * `A 1` and `A-1` both arrive here as `a 1`, and both mean `A1`. Done before
 * classification so the code is one token by the time anything else looks at it.
 */
function glueCodes(words: string[], known: Set<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const next = words[i + 1]
    if (
      /^[a-z]{1,2}$/.test(word) &&
      next !== undefined &&
      /^\d{1,3}$/.test(next) &&
      known.has(word + next)
    ) {
      out.push(word + next)
      i += 1
      continue
    }
    out.push(word)
  }
  return out
}

function tokenise(text: string, known: Set<string>): Token[] {
  const words = glueCodes(normalise(text).split(' ').filter((word) => word !== ''), known)
  const tokens: Token[] = []

  for (const word of words) {
    // Quantity forms that carry their own number: `2pcs`, `x2`, `2x`, `3pc`.
    const attached = /^(?:x(\d{1,3})|(\d{1,3})x|(\d{1,3})\s?(?:pcs?|pieces?)|(?:pcs?)(\d{1,3}))$/.exec(word)
    if (attached !== null) {
      const digits = attached[1] ?? attached[2] ?? attached[3] ?? attached[4]!
      tokens.push({ text: word, kind: 'qty', value: Number(digits) })
      continue
    }

    // A code the session actually sells. Checked before the bare-number branch so
    // `b10` is one code and not a letter beside a ten.
    if (known.has(word)) {
      tokens.push({ text: word, kind: 'code', value: word })
      continue
    }

    // Code-shaped but not ours. Kept as its own kind so `mine Z9` can be reported
    // as an unknown code rather than silently becoming a claim on something else.
    if (/^[a-z]{1,2}\d{1,3}$/.test(word)) {
      tokens.push({ text: word, kind: 'content', value: word })
      continue
    }

    if (/^\d{1,3}$/.test(word)) {
      tokens.push({ text: word, kind: 'qty', value: Number(word) })
      continue
    }

    // A long run of digits is a phone number, not a quantity of eleven.
    if (/^\d+$/.test(word)) {
      tokens.push({ text: word, kind: 'content' })
      continue
    }

    if (NUMBER_WORDS[word] !== undefined) {
      tokens.push({ text: word, kind: 'qty', value: NUMBER_WORDS[word] })
      continue
    }

    if (MARKERS.has(word)) {
      tokens.push({ text: word, kind: 'marker' })
      continue
    }

    tokens.push({ text: word, kind: FILLER.has(word) ? 'filler' : 'content' })
  }

  // Two-word markers, promoted after the fact.
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const pair = [tokens[i]!.text, tokens[i + 1]!.text]
    if (MARKER_PAIRS.some(([a, b]) => a === pair[0] && b === pair[1])) {
      tokens[i]!.kind = 'marker'
      tokens[i + 1]!.kind = 'marker'
    }
  }

  return tokens
}

/**
 * The quantity that belongs to the code at `index`.
 *
 * Adjacency decides it, not proximity: a number counts only when nothing but filler
 * separates it from the code. That is what keeps `mine A1 size 7` at one — `size`
 * is a content word, so the 7 belongs to it and not to A1.
 *
 * Looks right first (`A1 2pcs`), then left (`2 A1`, `dalawa A1`), because the code
 * usually comes first when a buyer writes both.
 */
function quantityFor(tokens: Token[], index: number): number | null {
  for (const direction of [1, -1]) {
    for (let i = index + direction; i >= 0 && i < tokens.length; i += direction) {
      const token = tokens[i]!
      if (token.kind === 'qty') return token.value as number
      if (token.kind === 'filler' || token.kind === 'marker') continue
      break
    }
  }
  return null
}

/**
 * A quantity anywhere in the comment.
 *
 * Only ever consulted for a **bare** claim — `mine 2` with an item on screen —
 * where there is no code for it to be adjacent to. Using it as a fallback when a
 * code *is* present reads `mine A1 size 7` as seven units and `mine po A1 (sorry
 * double post)` as two, because the number is nowhere near the code and belongs to
 * a different phrase entirely.
 */
function loneQuantity(tokens: Token[]): number | null {
  const quantities = tokens.filter((token) => token.kind === 'qty')
  return quantities.length === 1 ? (quantities[0]!.value as number) : null
}

function clamp(qty: number | null): number {
  if (qty === null || !Number.isFinite(qty) || qty < 1) return 1
  // Over the cap the number is something else the buyer typed. One is the safe
  // reading: it under-sells rather than blanking the item for everyone.
  return qty > MAX_QTY ? 1 : Math.floor(qty)
}

/**
 * Read a comment.
 *
 * Pure, synchronous and free of any notion of a database — the ingest layer decides
 * what to do with the result, and the same function scores the corpus, replays a log
 * and runs on the live path.
 */
export function parseComment(text: string, context: ParseContext): ParseResult {
  const known = new Set(context.codes.map((code) => code.toLowerCase()))
  const canonical = new Map(context.codes.map((code) => [code.toLowerCase(), code]))
  const tokens = tokenise(text, known)

  const codeTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.kind === 'code')

  const unknownCodes = tokens
    .filter((token) => token.kind === 'content' && /^[a-z]{1,2}\d{1,3}$/.test(token.text))
    .map((token) => token.text.toUpperCase())

  const hasMarker = tokens.some((token) => token.kind === 'marker')

  // Rule 3. Without a marker, anything the parser cannot account for means this is
  // conversation. `ang ganda ng A1` has `ganda` and `ang`… and `ganda` is content.
  if (!hasMarker) {
    const unaccounted = tokens.some((token) => token.kind === 'content')
    if (unaccounted || codeTokens.length === 0) {
      return {
        claims: [],
        reason: unknownCodes.length > 0 && codeTokens.length === 0 ? 'unknown_code' : 'not_a_claim',
        unknownCodes,
      }
    }
  }

  // Rule 4. A named code we do not sell is never a fallback to what is on screen.
  if (codeTokens.length === 0 && unknownCodes.length > 0) {
    return { claims: [], reason: 'unknown_code', unknownCodes }
  }

  // Rule 5. A bare marker claims what the seller is holding up.
  if (codeTokens.length === 0) {
    const current = context.currentCode ?? null
    if (current === null) {
      return { claims: [], reason: 'no_item_on_screen', unknownCodes }
    }
    return {
      claims: [{ code: current, qty: clamp(loneQuantity(tokens)) }],
      reason: 'claimed',
      unknownCodes,
    }
  }

  // One code: the quantity is whatever sits next to it, or one. Deliberately not
  // "any number in the comment" — see `loneQuantity`.
  if (codeTokens.length === 1) {
    const only = codeTokens[0]!
    const qty = quantityFor(tokens, only.index)
    return {
      claims: [{ code: canonical.get(only.token.value as string)!, qty: clamp(qty) }],
      reason: 'claimed',
      unknownCodes,
    }
  }

  // Several codes: each takes the quantity adjacent to it, or one.
  const seen = new Map<string, number>()
  for (const { token, index } of codeTokens) {
    const code = canonical.get(token.value as string)!
    const qty = clamp(quantityFor(tokens, index))
    // The same code twice in one comment is emphasis, not eight units.
    seen.set(code, Math.max(seen.get(code) ?? 0, qty))
  }

  return {
    claims: [...seen].map(([code, qty]) => ({ code, qty })),
    reason: 'claimed',
    unknownCodes,
  }
}
