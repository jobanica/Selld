import { describe, expect, it } from 'vitest'

import { createLogSmsProvider, encodingOf, estimateSms, segmentsFor } from './log-provider'

describe('SMS encoding detection', () => {
  it('treats plain Taglish as GSM-7', () => {
    expect(encodingOf('Salamat sa order mo! Order #0001, P378.00 cash on delivery.')).toBe('gsm7')
  })

  it('keeps ñ in GSM-7 — it is in the standard alphabet', () => {
    // This matters for PH copy specifically: "Las Piñas", "Niño". Mis-classifying it
    // as UCS-2 would halve the segment budget and double the seller's bill on every
    // message mentioning a place with an ñ in it.
    expect(encodingOf('Las Piñas, Parañaque')).toBe('gsm7')
  })

  it('falls to UCS-2 for an emoji', () => {
    // One emoji in a broadcast doubles the cost for every recipient.
    expect(encodingOf('Thanks for your order 🎉')).toBe('ucs2')
  })
})

describe('segmentsFor()', () => {
  it('counts one segment up to 160 GSM-7 characters', () => {
    expect(segmentsFor('a'.repeat(160))).toBe(1)
    expect(segmentsFor('a'.repeat(161))).toBe(2)
  })

  it('uses 153 per part once concatenated, not 160', () => {
    // Concatenated parts spend 6 septets on the user-data header. Dividing by 160
    // under-counts, which under-bills, which shows up as a margin hole.
    expect(segmentsFor('a'.repeat(306))).toBe(2)
    expect(segmentsFor('a'.repeat(307))).toBe(3)
  })

  it('drops to 70 characters for UCS-2', () => {
    expect(segmentsFor('🎉'.repeat(35))).toBe(1)
    expect(segmentsFor(`${'a'.repeat(70)}🎉`)).toBe(2)
  })

  it('charges extended-table characters as two septets', () => {
    // `{`, `}`, `[`, `]`, `€` and friends cost two. 80 of them is 160 septets.
    expect(segmentsFor('{'.repeat(80))).toBe(1)
    expect(segmentsFor('{'.repeat(81))).toBe(2)
  })

  it('never reports zero segments for an empty body', () => {
    expect(segmentsFor('')).toBe(1)
  })
})

describe('estimateSms()', () => {
  it('prices per segment', () => {
    expect(estimateSms('short').cost).toBe(30)
    expect(estimateSms('a'.repeat(200)).cost).toBe(60)
  })
})

describe('createLogSmsProvider()', () => {
  it('returns a stable providerRef for the same idempotency key', () => {
    // A retry must be recognisable as the same message. A random reference would
    // make the log undeduplicable, which is the whole point of hard rule 7.
    const lines: string[] = []
    const provider = createLogSmsProvider((line) => lines.push(line))
    const input = {
      to: '+639171234567',
      body: 'hi',
      purpose: 'tracking' as const,
      idempotencyKey: 'tenant|sms.order_confirmed|order-1|0',
    }
    return Promise.all([provider.send(input), provider.send(input)]).then(([a, b]) => {
      expect(a.providerRef).toBe(b.providerRef)
      expect(a.status).toBe('sent')
      expect(lines).toHaveLength(2)
    })
  })

  it('reports a real cost rather than zero', () => {
    const provider = createLogSmsProvider(() => {})
    return provider
      .send({
        to: '+639171234567',
        body: 'a'.repeat(200),
        purpose: 'tracking',
        idempotencyKey: 'k',
      })
      .then((result) => {
        // A provider that always says "free" would hide arithmetic bugs in the
        // credit ledger until it was billing a seller wrongly.
        expect(result.cost).toBeGreaterThan(0)
        expect(result.segments).toBe(2)
      })
  })
})

describe('the peso sign is a cost decision, not a style one', () => {
  it('costs two segments with ₱ and one without', () => {
    // Found by measuring a real confirmation SMS: 122 characters, two segments.
    // `₱` is absent from GSM-7, so one character forced the whole message to UCS-2
    // and halved the per-segment budget from 160 to 70 — doubling what the seller
    // pays on every single order.
    const withSign = "Salamat sa order mo sa Rhea's Finds! Order #0006, ₱229.00 cash on delivery. Ite-text namin ang tracking kapag na-ship na."
    const withoutSign = withSign.replace('₱', 'PHP ')

    expect(withSign.length).toBeLessThan(160)
    expect(encodingOf(withSign)).toBe('ucs2')
    expect(segmentsFor(withSign)).toBe(2)

    expect(encodingOf(withoutSign)).toBe('gsm7')
    expect(segmentsFor(withoutSign)).toBe(1)
    expect(estimateSms(withoutSign).cost).toBeLessThan(estimateSms(withSign).cost)
  })
})
