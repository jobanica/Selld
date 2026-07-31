/**
 * A labelled corpus of live-selling comments.
 *
 * ## Read this before changing anything here
 *
 * This file was written **before** the parser, on purpose, and it is the phase-7
 * lesson applied to a much bigger surface: a fixture that was written to match an
 * implementation tests nothing. Every entry below is what a Filipino buyer actually
 * types into a Facebook Live comment box, hand-labelled with what a human reading it
 * would understand — not with what `parseComment` currently returns.
 *
 * When the parser disagrees with a label, the presumption is that the **parser** is
 * wrong. Changing a label to make a test pass is only legitimate when the label was
 * genuinely mis-read by the person who wrote it, and that should be rare and
 * commented.
 *
 * ## What live selling actually looks like
 *
 * A seller holds up an item, says "A1 po ito, five hundred", and the comments come
 * in faster than anyone can read. Most are one or two words. Very few are
 * well-formed. The recurring shapes:
 *
 * - **Bare claims.** The seller has just announced the item, so the buyer types only
 *   `mine`. This is the single most common comment in a PH live session, and it is
 *   why a session tracks which item is on screen.
 * - **Code plus a claim word**, in either order: `A1 mine`, `mine A1`, `sakin A1`.
 * - **Quantities** written eight different ways: `2pcs`, `2 pcs`, `x2`, `2x`,
 *   `dalawa`, `two`, `2`, `double`.
 * - **Taglish and Bisaya.** `sakin`, `akin`, `sa akin`, `akoa`, `sa ako`, `ako ni`,
 *   `kuha ko`. Sellers in Cebu and Davao get most of their comments in Bisaya.
 * - **Questions that look like claims.** `A1 magkano?`, `available pa po A1?`,
 *   `ano size ng A1?`. These are the dangerous ones: reserving stock for a question
 *   is how a live session sells out on paper while nobody is buying.
 *
 * `current` is the item the seller has on screen when the comment lands, which is
 * what a bare `mine` refers to. `null` means nothing is being shown.
 */

export interface CorpusEntry {
  /** The comment, exactly as typed. */
  text: string
  /** Facebook's per-page-scoped user id. Repeats are the same buyer. */
  psid: string
  /** Which claim code the seller has on screen, or null. */
  current: string | null
  /**
   * What a human reading this comment would understand it to claim.
   * `[]` means "this is not a claim" — a question, a greeting, a compliment.
   */
  expect: { code: string; qty: number }[]
  /** Why this entry is in the corpus, when it is not obvious. */
  note?: string
}

/** The codes on offer in the session these comments came from. */
export const CORPUS_CODES = ['A1', 'A2', 'A3', 'B1', 'B2', 'B10', 'C5'] as const

export const CORPUS: CorpusEntry[] = [
  // ---- The bare claim: the most common comment in any PH live session ----
  { text: 'mine', psid: 'p001', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'Mine', psid: 'p002', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'MINE', psid: 'p003', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine po', psid: 'p004', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine po ako', psid: 'p005', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'miness', psid: 'p006', current: 'A1', expect: [{ code: 'A1', qty: 1 }],
    note: 'Buyers stretch it for emphasis. Very common.' },
  { text: 'minee', psid: 'p007', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine!!!', psid: 'p008', current: 'A1', expect: [{ code: 'A1', qty: 1 }] },
  { text: 'sakin', psid: 'p009', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'sa akin po', psid: 'p010', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'akin na po', psid: 'p011', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'akoa', psid: 'p012', current: 'A2', expect: [{ code: 'A2', qty: 1 }],
    note: 'Bisaya. A Cebu or Davao seller gets a lot of these.' },
  { text: 'sa ako', psid: 'p013', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'ako ni', psid: 'p014', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'akin yan', psid: 'p015', current: 'A2', expect: [{ code: 'A2', qty: 1 }] },
  { text: 'get', psid: 'p016', current: 'A3', expect: [{ code: 'A3', qty: 1 }] },
  { text: 'claim', psid: 'p017', current: 'A3', expect: [{ code: 'A3', qty: 1 }] },
  { text: 'claiming', psid: 'p018', current: 'A3', expect: [{ code: 'A3', qty: 1 }] },
  { text: 'kuha ko', psid: 'p019', current: 'A3', expect: [{ code: 'A3', qty: 1 }] },
  { text: 'kunin ko po', psid: 'p020', current: 'A3', expect: [{ code: 'A3', qty: 1 }] },

  // ---- Code plus claim word, both orders ----
  { text: 'A1 mine', psid: 'p021', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine A1', psid: 'p022', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine po A1', psid: 'p023', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'a1 mine po', psid: 'p024', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A1 MINE', psid: 'p025', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'sakin yung a1', psid: 'p026', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'sakin na po yung A2', psid: 'p027', current: null, expect: [{ code: 'A2', qty: 1 }] },
  { text: 'akoa ang b1', psid: 'p028', current: null, expect: [{ code: 'B1', qty: 1 }] },
  { text: 'B2 sakin', psid: 'p029', current: null, expect: [{ code: 'B2', qty: 1 }] },
  { text: 'mine b10', psid: 'p030', current: null, expect: [{ code: 'B10', qty: 1 }],
    note: 'Two-digit codes exist and must not be truncated to B1.' },
  { text: 'B10 mine po', psid: 'p031', current: null, expect: [{ code: 'B10', qty: 1 }] },

  // ---- A code on its own. Ambiguous in theory, a claim in practice ----
  { text: 'A1', psid: 'p032', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'Nobody types a bare code to make conversation during a live sale.' },
  { text: 'a3', psid: 'p033', current: null, expect: [{ code: 'A3', qty: 1 }] },
  { text: 'C5 po', psid: 'p034', current: null, expect: [{ code: 'C5', qty: 1 }] },

  // ---- Spacing and punctuation inside the code ----
  { text: 'A 1 mine', psid: 'p035', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A-1 mine', psid: 'p036', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'a.1 mine po', psid: 'p037', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine A1.', psid: 'p038', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A1!', psid: 'p039', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A1 ❤️', psid: 'p040', current: null, expect: [{ code: 'A1', qty: 1 }] },

  // ---- Quantities, in every form sellers actually see ----
  { text: 'mine po A1 2pcs', psid: 'p041', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 2 pcs', psid: 'p042', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 x2', psid: 'p043', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 2x', psid: 'p044', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 x 3', psid: 'p045', current: null, expect: [{ code: 'A1', qty: 3 }] },
  { text: '2 A1', psid: 'p046', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 3', psid: 'p047', current: null, expect: [{ code: 'A1', qty: 3 }] },
  { text: 'dalawa A1', psid: 'p048', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'A1 dalawa po', psid: 'p049', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'tatlo po A2', psid: 'p050', current: null, expect: [{ code: 'A2', qty: 3 }] },
  { text: 'isa lang A2', psid: 'p051', current: null, expect: [{ code: 'A2', qty: 1 }] },
  { text: 'apat na A3', psid: 'p052', current: null, expect: [{ code: 'A3', qty: 4 }] },
  { text: 'lima A3', psid: 'p053', current: null, expect: [{ code: 'A3', qty: 5 }] },
  { text: 'two A1 po', psid: 'p054', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'three po B1', psid: 'p055', current: null, expect: [{ code: 'B1', qty: 3 }] },
  { text: 'duha ang B2', psid: 'p056', current: null, expect: [{ code: 'B2', qty: 2 }],
    note: 'Bisaya for two.' },
  { text: 'tulo B2 po', psid: 'p057', current: null, expect: [{ code: 'B2', qty: 3 }],
    note: 'Bisaya for three.' },
  { text: 'mine 2', psid: 'p058', current: 'A1', expect: [{ code: 'A1', qty: 2 }] },
  { text: 'mine po 2pcs', psid: 'p059', current: 'A1', expect: [{ code: 'A1', qty: 2 }] },
  { text: 'sakin dalawa', psid: 'p060', current: 'A2', expect: [{ code: 'A2', qty: 2 }] },
  { text: 'A1 1pc', psid: 'p061', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A1 10pcs', psid: 'p062', current: null, expect: [{ code: 'A1', qty: 10 }] },

  // ---- Several claims in one comment ----
  { text: 'A1 and B2 mine', psid: 'p063', current: null,
    expect: [{ code: 'A1', qty: 1 }, { code: 'B2', qty: 1 }] },
  { text: 'mine A1, A2', psid: 'p064', current: null,
    expect: [{ code: 'A1', qty: 1 }, { code: 'A2', qty: 1 }] },
  { text: 'A1 2pcs B2 1pc', psid: 'p065', current: null,
    expect: [{ code: 'A1', qty: 2 }, { code: 'B2', qty: 1 }] },
  { text: 'sakin A1 at A3 po', psid: 'p066', current: null,
    expect: [{ code: 'A1', qty: 1 }, { code: 'A3', qty: 1 }] },
  { text: 'mine A1 x2 and B10 x3', psid: 'p067', current: null,
    expect: [{ code: 'A1', qty: 2 }, { code: 'B10', qty: 3 }] },
  { text: 'A1/A2 mine po', psid: 'p068', current: null,
    expect: [{ code: 'A1', qty: 1 }, { code: 'A2', qty: 1 }] },

  // ---- Chatter around a real claim ----
  { text: 'mine po A1 ang ganda!!', psid: 'p069', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'ay grabe mine na mine ako dyan A2', psid: 'p070', current: null,
    expect: [{ code: 'A2', qty: 1 }] },
  { text: 'first time ko mag join, mine po A3', psid: 'p071', current: null,
    expect: [{ code: 'A3', qty: 1 }] },
  { text: 'mine po ate A1 salamat', psid: 'p072', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'A1 mine po, cod ba ito?', psid: 'p073', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'A claim with a question attached is still a claim.' },

  // ---- Not claims. Reserving stock for any of these loses a real sale ----
  { text: 'magkano po A1?', psid: 'p074', current: null, expect: [] },
  { text: 'A1 magkano', psid: 'p075', current: null, expect: [] },
  { text: 'how much po yung A1', psid: 'p076', current: null, expect: [] },
  { text: 'pila ang A1?', psid: 'p077', current: null, expect: [],
    note: 'Bisaya for "how much".' },
  { text: 'available pa po ba ang A2?', psid: 'p078', current: null, expect: [] },
  { text: 'meron pa po ba nyan?', psid: 'p079', current: 'A2', expect: [] },
  { text: 'ano size po ng A3?', psid: 'p080', current: null, expect: [] },
  { text: 'may medium pa po?', psid: 'p081', current: 'A3', expect: [] },
  { text: 'ang ganda ng A1', psid: 'p082', current: null, expect: [],
    note: 'A compliment, not a claim. The hardest negative in the set.' },
  { text: 'ganda ng b2 nakakatempt', psid: 'p083', current: null, expect: [] },
  { text: 'sana all A1', psid: 'p084', current: null, expect: [] },
  { text: 'next time na lang po', psid: 'p085', current: 'A1', expect: [] },
  { text: 'wala na po ba A1?', psid: 'p086', current: null, expect: [] },
  { text: 'sold out na po ba yan', psid: 'p087', current: 'A1', expect: [] },
  { text: 'hi po', psid: 'p088', current: 'A1', expect: [] },
  { text: 'good evening', psid: 'p089', current: 'A1', expect: [] },
  { text: '❤️❤️❤️', psid: 'p090', current: 'A1', expect: [] },
  { text: 'watching from qatar', psid: 'p091', current: 'A1', expect: [] },
  { text: 'ate pa view po ng likod', psid: 'p092', current: 'A1', expect: [] },
  { text: 'pa-share po', psid: 'p093', current: 'A1', expect: [] },
  { text: 'anong price nito', psid: 'p094', current: 'A1', expect: [] },
  { text: 'saan po kayo located', psid: 'p095', current: 'A1', expect: [] },
  { text: 'may free shipping po ba', psid: 'p096', current: 'A1', expect: [] },
  { text: 'ilan na po natitira', psid: 'p097', current: 'A1', expect: [] },
  { text: 'A1 A2 A3 lahat maganda', psid: 'p098', current: null, expect: [],
    note: 'Three codes and no claim word. Enumeration, not an order.' },
  { text: 'nakuha ko na po yung A1 kahapon', psid: 'p099', current: null, expect: [],
    note: 'Past tense: a previous purchase, not a new claim.' },

  // ---- Codes that are not on offer in this session ----
  { text: 'mine Z9', psid: 'p100', current: null, expect: [],
    note: 'No such code. Must not silently claim the current item instead.' },
  { text: 'D4 mine po', psid: 'p101', current: null, expect: [] },
  { text: 'mine A9', psid: 'p102', current: null, expect: [] },

  // ---- The same buyer, twice ----
  { text: 'mine A1', psid: 'p103', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'mine A1', psid: 'p103', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'Parses the same. Deduplication is the ingest layer’s job, not the parser’s.' },
  { text: 'mine po A1 (sorry double post)', psid: 'p103', current: null,
    expect: [{ code: 'A1', qty: 1 }] },

  // ---- Numbers that are not quantities ----
  { text: 'A1 mine po, 09171234567', psid: 'p104', current: null,
    expect: [{ code: 'A1', qty: 1 }],
    note: 'Buyers volunteer a phone number. It is not a quantity of eleven.' },
  { text: 'mine A1 size 7', psid: 'p105', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'A size is not a quantity.' },
  { text: 'A1 500 mine', psid: 'p106', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'Repeating the price back is not an order for five hundred.' },
  { text: 'mine A1 100pcs', psid: 'p107', current: null, expect: [{ code: 'A1', qty: 1 }],
    note: 'Beyond any plausible live-sale quantity. Treated as 1 and left to the operator.' },

  // ---- Whitespace, emoji, mixed case ----
  { text: '  mine   po   A1  ', psid: 'p108', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'MINE PO A1 2PCS', psid: 'p109', current: null, expect: [{ code: 'A1', qty: 2 }] },
  { text: 'mine🥰 A1', psid: 'p110', current: null, expect: [{ code: 'A1', qty: 1 }] },
  { text: 'Mine Po A2 Dalawa', psid: 'p111', current: null, expect: [{ code: 'A2', qty: 2 }] },
  { text: '', psid: 'p112', current: 'A1', expect: [] },
  { text: '   ', psid: 'p113', current: 'A1', expect: [] },

  // ---- Bare claim with nothing on screen ----
  { text: 'mine', psid: 'p114', current: null, expect: [],
    note: 'Nothing is being shown, so there is nothing to claim. The operator sees it as unmatched rather than as a guess.' },
  { text: 'sakin po', psid: 'p115', current: null, expect: [] },

  // ---- Longer, messier, still a claim ----
  { text: 'ate mine po ako ng A1 2pcs, cod po sana', psid: 'p116', current: null,
    expect: [{ code: 'A1', qty: 2 }] },
  { text: 'sis akoa ang B10 duha ha, salamat', psid: 'p117', current: null,
    expect: [{ code: 'B10', qty: 2 }] },
  { text: 'mine po ng A1 tsaka A2, isa each', psid: 'p118', current: null,
    expect: [{ code: 'A1', qty: 1 }, { code: 'A2', qty: 1 }] },
  { text: 'grabe ang bilis, mine po C5', psid: 'p119', current: null,
    expect: [{ code: 'C5', qty: 1 }] },
  { text: 'akin na po yung dalawang A1', psid: 'p120', current: null,
    expect: [{ code: 'A1', qty: 2 }],
    note: '"dalawang" — the linker form. Common and easy to miss.' },
]
