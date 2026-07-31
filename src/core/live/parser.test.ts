import { describe, expect, it } from 'vitest'

import { CORPUS, CORPUS_CODES, type CorpusEntry } from './corpus'
import { parseComment } from './parser'

/**
 * The corpus is scored as a whole, not asserted entry by entry.
 *
 * The build spec asks for ≥95% parse accuracy on a replay of a real comment log,
 * and a per-entry `expect()` would not measure that — it would measure whether
 * anyone had remembered to delete the entries that fail. Scoring the whole set
 * means a change that fixes five comments and breaks six is visible as a
 * regression, which is the property that matters when the rules are heuristics.
 *
 * A per-entry breakdown is printed for every miss, because "94.2%" on its own tells
 * nobody which comment stopped working.
 */

function score(entries: CorpusEntry[]) {
  const misses: { entry: CorpusEntry; got: { code: string; qty: number }[] }[] = []

  for (const entry of entries) {
    const result = parseComment(entry.text, {
      codes: CORPUS_CODES,
      currentCode: entry.current,
    })
    const got = [...result.claims].sort((a, b) => a.code.localeCompare(b.code))
    const want = [...entry.expect].sort((a, b) => a.code.localeCompare(b.code))
    if (JSON.stringify(got) !== JSON.stringify(want)) misses.push({ entry, got })
  }

  return { total: entries.length, misses, accuracy: (entries.length - misses.length) / entries.length }
}

describe('the live comment corpus', () => {
  it('parses at least 95% of a real-shaped comment log', () => {
    const result = score(CORPUS)

    if (result.misses.length > 0) {
      console.log(`\n${result.misses.length} of ${result.total} missed:`)
      for (const miss of result.misses) {
        console.log(
          `  ${JSON.stringify(miss.entry.text)} (on screen: ${miss.entry.current ?? 'nothing'})` +
            `\n    want ${JSON.stringify(miss.entry.expect)}` +
            `\n    got  ${JSON.stringify(miss.got)}`,
        )
      }
    }

    expect(result.accuracy).toBeGreaterThanOrEqual(0.95)
  })

  /**
   * The asymmetric half, scored on its own.
   *
   * A missed claim costs a sale and the buyer usually re-comments. A *false* claim
   * reserves stock nobody is buying, shows the item sold out while the seller is
   * still holding it, and turns away everyone after. So the negatives carry a
   * higher bar than the overall score.
   */
  it('almost never invents a claim out of conversation', () => {
    const negatives = CORPUS.filter((entry) => entry.expect.length === 0)
    const falsePositives = negatives.filter(
      (entry) =>
        parseComment(entry.text, { codes: CORPUS_CODES, currentCode: entry.current }).claims
          .length > 0,
    )

    if (falsePositives.length > 0) {
      console.log('\nfalse claims:')
      for (const entry of falsePositives) console.log(`  ${JSON.stringify(entry.text)}`)
    }

    expect(falsePositives.length / negatives.length).toBeLessThanOrEqual(0.02)
  })
})

describe('parseComment', () => {
  const ctx = { codes: CORPUS_CODES }

  it('reads a bare claim as the item on screen', () => {
    expect(parseComment('mine po', { ...ctx, currentCode: 'A1' }).claims).toEqual([
      { code: 'A1', qty: 1 },
    ])
  })

  it('claims nothing when nothing is on screen', () => {
    const result = parseComment('mine po', { ...ctx, currentCode: null })
    expect(result.claims).toEqual([])
    expect(result.reason).toBe('no_item_on_screen')
  })

  it('never falls back to the screen when the buyer named a code we do not sell', () => {
    // The dangerous one: the buyer asked for Z9 and the seller is holding A1.
    // Guessing past what they said ships the wrong item to a real address.
    const result = parseComment('mine Z9', { ...ctx, currentCode: 'A1' })
    expect(result.claims).toEqual([])
    expect(result.reason).toBe('unknown_code')
    expect(result.unknownCodes).toEqual(['Z9'])
  })

  it('does not truncate a two-digit code', () => {
    expect(parseComment('mine B10', ctx).claims).toEqual([{ code: 'B10', qty: 1 }])
  })

  it('keeps the seller’s own casing on the way out', () => {
    expect(parseComment('a1 mine', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
  })

  it('caps an implausible quantity rather than trusting it', () => {
    // `A1 500 mine` is a buyer repeating the price back. Reserving five hundred
    // blanks the item for everyone else in the session.
    expect(parseComment('A1 500 mine', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
    expect(parseComment('mine A1 100pcs', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
  })

  it('does not read a phone number as a quantity', () => {
    expect(parseComment('A1 mine po 09171234567', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
  })

  it('gives each code in a comment its own quantity', () => {
    expect(parseComment('mine A1 x2 and B10 x3', ctx).claims).toEqual([
      { code: 'A1', qty: 2 },
      { code: 'B10', qty: 3 },
    ])
  })

  it('treats the same code twice as emphasis, not as more units', () => {
    expect(parseComment('mine A1 A1 please', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
  })

  it('matches whole tokens, so a past-tense comment is not a claim', () => {
    // `nakuha ko` contains `kuha ko`. Substring matching would read a buyer
    // talking about yesterday's parcel as a new order.
    const result = parseComment('nakuha ko na po yung A1 kahapon', ctx)
    expect(result.claims).toEqual([])
  })

  it('is not fooled by a question that contains a code', () => {
    for (const question of ['magkano po A1?', 'available pa po ba ang A2?', 'pila ang A1?']) {
      expect(parseComment(question, ctx).claims).toEqual([])
    }
  })

  it('reads a claim even when a question is attached to it', () => {
    expect(parseComment('A1 mine po, cod ba ito?', ctx).claims).toEqual([{ code: 'A1', qty: 1 }])
  })

  it('understands Bisaya', () => {
    expect(parseComment('akoa ang b1', ctx).claims).toEqual([{ code: 'B1', qty: 1 }])
    expect(parseComment('duha ang B2', ctx).claims).toEqual([{ code: 'B2', qty: 2 }])
    expect(parseComment('sis akoa ang B10 duha ha, salamat', ctx).claims).toEqual([
      { code: 'B10', qty: 2 },
    ])
  })

  it('handles an empty comment', () => {
    expect(parseComment('', { ...ctx, currentCode: 'A1' }).claims).toEqual([])
    expect(parseComment('   ', { ...ctx, currentCode: 'A1' }).claims).toEqual([])
  })
})
