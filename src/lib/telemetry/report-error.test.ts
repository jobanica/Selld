import { afterEach, describe, expect, it, vi } from 'vitest'

import { initTelemetry, parseDsn, reportError } from './report-error'
import { REDACTED } from './scrub'

const DSN = 'https://abc123@o1.ingest.example.test/42'

afterEach(() => {
  initTelemetry(null)
})

describe('parseDsn', () => {
  it('derives the envelope endpoint operators never have to type', () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: 'https://o1.ingest.example.test/api/42/envelope/',
      publicKey: 'abc123',
    })
  })

  it('returns null for anything that is not a DSN, rather than half-working', () => {
    expect(parseDsn('')).toBe(null)
    expect(parseDsn('https://o1.ingest.example.test/42')).toBe(null)
    expect(parseDsn('nonsense')).toBe(null)
  })
})

describe('reportError', () => {
  it('sends nothing at all when no DSN is configured', () => {
    const fetchImpl = vi.fn()
    initTelemetry(null)
    expect(reportError(new Error('boom'))).toBe(null)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * The assertions that matter. Each one is a value that would otherwise reach a
   * third party's servers — so they are made against the envelope that *left*,
   * not against what was passed in.
   */
  it('scrubs a phone number out of the message', () => {
    initTelemetry({ dsn: DSN, environment: 'test', fetchImpl: vi.fn(() => Promise.resolve(new Response())) })
    const sent = JSON.stringify(reportError(new Error('SMS to 09171234567 was rejected')))
    expect(sent).not.toContain('9171234567')
    expect(sent).toContain(REDACTED)
  })

  it('scrubs the URL down to its query keys', () => {
    initTelemetry({ dsn: DSN, environment: 'test', fetchImpl: vi.fn(() => Promise.resolve(new Response())) })
    const sent = JSON.stringify(
      reportError(new Error('boom'), { url: 'https://x.test/checkout?phone=09171234567' }),
    )
    expect(sent).toContain('phone=')
    expect(sent).not.toContain('9171234567')
  })

  it('scrubs a street address out of the extra payload', () => {
    initTelemetry({ dsn: DSN, environment: 'test', fetchImpl: vi.fn(() => Promise.resolve(new Response())) })
    const sent = JSON.stringify(
      reportError(new Error('boom'), { extra: { street: '21 Rizal Street', orderId: 'ord_1' } }),
    )
    expect(sent).not.toContain('Rizal')
    // ...while keeping the part that makes the report worth having.
    expect(sent).toContain('ord_1')
  })

  it('never sends headers, cookies or a user — there is no safe version of those', () => {
    initTelemetry({ dsn: DSN, environment: 'test', fetchImpl: vi.fn(() => Promise.resolve(new Response())) })
    const envelope = reportError(new Error('boom'), { url: '/x' }) as Record<string, unknown>
    expect(envelope.user).toBeUndefined()
    expect((envelope.request as Record<string, unknown>).headers).toBeUndefined()
    expect((envelope.request as Record<string, unknown>).cookies).toBeUndefined()
  })

  it('does not throw when the transport does', () => {
    // Reporting an error must never become the error.
    initTelemetry({
      dsn: DSN,
      environment: 'test',
      fetchImpl: vi.fn(() => {
        throw new Error('network is down')
      }),
    })
    expect(() => reportError(new Error('boom'))).not.toThrow()
  })

  it('handles a rejection that is not an Error at all', () => {
    initTelemetry({ dsn: DSN, environment: 'test', fetchImpl: vi.fn(() => Promise.resolve(new Response())) })
    const sent = JSON.stringify(reportError('plain string 09171234567'))
    expect(sent).not.toContain('9171234567')
  })
})
