import { describe, expect, it } from 'vitest'

import { REDACTED, scrub, scrubText, scrubUrl } from './scrub'

/**
 * These are not tests of a formatter. Every case below is a thing that would
 * otherwise be sent to a third party's servers, and phase 20 has a `breach_log`
 * table for the day one of them is.
 */
describe('scrubText', () => {
  it('masks a PH mobile in every form this codebase handles', () => {
    for (const phone of ['09171234567', '+639171234567', '639171234567']) {
      expect(scrubText(`ringing ${phone} now`)).toBe(`ringing ${REDACTED} now`)
    }
  })

  it('masks a phone number written into a hand-typed message', () => {
    // The reason this is shape-based rather than key-based: nobody can enumerate
    // the places a number ends up, and a seller's error note is one of them.
    expect(scrubText('SMS to 09171234567 failed: rejected by provider')).toBe(
      `SMS to ${REDACTED} failed: rejected by provider`,
    )
  })

  it('masks an email address', () => {
    expect(scrubText('no user marites@example.ph')).toBe(`no user ${REDACTED}`)
  })

  it('masks a cart token, which is a session', () => {
    const token = 'a'.repeat(64)
    expect(scrubText(`cart ${token} not found`)).toBe(`cart ${REDACTED} not found`)
  })

  it('masks a JWT and a provider key', () => {
    expect(scrubText('bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.dBjftJeZ4CV')).toContain(REDACTED)
    expect(scrubText('key sk_live_abcdef123456 rejected')).toBe(`key ${REDACTED} rejected`)
  })

  it('leaves an ordinary message alone', () => {
    expect(scrubText('insufficient stock for variant')).toBe('insufficient stock for variant')
  })
})

describe('scrubUrl', () => {
  it('keeps query keys and drops every value', () => {
    // The keys are what makes a report debuggable; the values are what makes it
    // a breach.
    expect(scrubUrl('https://x.test/checkout?phone=09171234567&ref=abc')).toBe(
      '/checkout?phone=&ref=',
    )
  })

  it('scrubs the path too, because an order number is a capability here', () => {
    expect(scrubUrl('/track/09171234567')).toBe(`/track/${REDACTED}`)
  })

  it('survives a value that is not a URL at all', () => {
    // Parsed against a placeholder base, so it comes back percent-encoded. What
    // matters is not the spelling but that the number did not survive.
    const out = scrubUrl('not a url 09171234567')
    expect(out).toContain(REDACTED)
    expect(out).not.toContain('9171234567')
  })
})

describe('scrub', () => {
  it('redacts by key where the value has no recognisable shape', () => {
    // A street address is just words. No pattern can catch it, so the key must.
    const out = scrub({ street: '21 Rizal Street', landmark: 'beside the sari-sari' }) as Record<
      string,
      unknown
    >
    expect(out.street).toBe(REDACTED)
    expect(out.landmark).toBe(REDACTED)
  })

  it('redacts credentials wherever they are nested', () => {
    const out = scrub({ courier: { name: 'jnt', credentials: { apiKey: 'live-123' } } }) as {
      courier: Record<string, unknown>
    }
    expect(out.courier.credentials).toBe(REDACTED)
    expect(out.courier.name).toBe('jnt')
  })

  it('keeps a name that is not a person: a courier, a product, a store', () => {
    // The counterweight to everything above. A report where every field says
    // [redacted] protects nobody and debugs nothing.
    const out = scrub({ courier: 'jnt', productName: 'Rosehip Serum' }) as Record<string, unknown>
    expect(out).toEqual({ courier: 'jnt', productName: 'Rosehip Serum' })
  })

  it('keeps the parts of a payload that make it useful', () => {
    const out = scrub({ orderId: 'ord_1', status: 'packed', qty: 3, ok: false }) as Record<
      string,
      unknown
    >
    expect(out).toEqual({ orderId: 'ord_1', status: 'packed', qty: 3, ok: false })
  })

  it('does not hang on a cycle', () => {
    const loop: Record<string, unknown> = { name: 'x' }
    loop.self = loop
    expect(() => scrub(loop)).not.toThrow()
  })

  it('caps a runaway array rather than serialising it', () => {
    const out = scrub(Array.from({ length: 5_000 }, (_, i) => i)) as unknown[]
    expect(out.length).toBe(50)
  })
})
