import { describe, expect, it, vi } from 'vitest'

import { classifyStatus, IntegrationError } from './errors'
import { idempotencyKey, syntheticWebhookEventId, webhookEventId } from './idempotency'
import { ProviderRegistry } from './registry'
import { backoffDelayMs, isRetryable, withRetry } from './retry'

const ctx = { provider: 'jnt', endpoint: '/order/create' }

describe('classifyStatus()', () => {
  it('treats 5xx and throttling as transient', () => {
    for (const status of [500, 502, 503, 504, 429, 408, 425]) {
      expect(classifyStatus(status), `status ${status}`).toBe('transient')
    }
  })

  it('treats auth failures separately so they surface to an operator', () => {
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
  })

  it('treats 409 as a duplicate — our earlier attempt probably succeeded', () => {
    expect(classifyStatus(409)).toBe('duplicate')
  })

  it('treats other 4xx as permanent', () => {
    for (const status of [400, 404, 422]) {
      expect(classifyStatus(status), `status ${status}`).toBe('permanent')
    }
  })
})

describe('withRetry()', () => {
  const noSleep = () => Promise.resolve()

  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures then succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(IntegrationError.transient('503', ctx))
      .mockRejectedValueOnce(IntegrationError.transient('503', ctx))
      .mockResolvedValue('booked')

    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('booked')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry permanent failures — an unserviceable barangay stays unserviceable', async () => {
    const error = IntegrationError.permanent('barangay not covered', ctx)
    const operation = vi.fn().mockRejectedValue(error)

    await expect(withRetry(operation, { sleep: noSleep })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not retry auth failures', async () => {
    const operation = vi.fn().mockRejectedValue(IntegrationError.auth('bad key', ctx))
    await expect(withRetry(operation, { sleep: noSleep })).rejects.toThrow('bad key')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const operation = vi.fn().mockRejectedValue(IntegrationError.transient('503', ctx))
    await expect(withRetry(operation, { attempts: 3, sleep: noSleep })).rejects.toThrow('503')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('reports each retry so it can be written to integration_logs', async () => {
    const onRetry = vi.fn()
    const operation = vi
      .fn()
      .mockRejectedValueOnce(IntegrationError.transient('boom', ctx))
      .mockResolvedValue('ok')

    await withRetry(operation, { sleep: noSleep, onRetry, random: () => 1 })

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 500 })
  })

  it("honours a provider's Retry-After hint when it exceeds our curve", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        IntegrationError.transient('slow down', { ...ctx, retryAfterMs: 5_000 }),
      )
      .mockResolvedValue('ok')

    await withRetry(operation, { sleep, random: () => 0 })
    expect(sleep).toHaveBeenCalledWith(5_000)
  })

  it('retries unclassified errors, which are usually network blips', async () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true)
    const operation = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(1)
    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe(1)
  })

  it('rejects a zero attempt budget', async () => {
    await expect(withRetry(() => Promise.resolve(1), { attempts: 0 })).rejects.toThrow(RangeError)
  })
})

describe('backoffDelayMs()', () => {
  it('grows exponentially and respects the cap', () => {
    const full = { random: () => 1, baseDelayMs: 500, maxDelayMs: 8_000 }
    expect(backoffDelayMs(1, full)).toBe(500)
    expect(backoffDelayMs(2, full)).toBe(1_000)
    expect(backoffDelayMs(3, full)).toBe(2_000)
    expect(backoffDelayMs(4, full)).toBe(4_000)
    expect(backoffDelayMs(5, full)).toBe(8_000)
    expect(backoffDelayMs(9, full)).toBe(8_000)
  })

  it('applies full jitter so 40 bulk bookings do not retry in lockstep', () => {
    expect(backoffDelayMs(3, { random: () => 0, baseDelayMs: 500 })).toBe(0)
    expect(backoffDelayMs(3, { random: () => 0.5, baseDelayMs: 500 })).toBe(1_000)
    expect(backoffDelayMs(3, { random: () => 1, baseDelayMs: 500 })).toBe(2_000)
  })
})

describe('idempotencyKey()', () => {
  it('is deterministic across retries and restarts', () => {
    const input = { tenantId: 't1', operation: 'shipment.book', entityId: 'ord_9' }
    expect(idempotencyKey(input)).toBe('t1|shipment.book|ord_9|0')
    expect(idempotencyKey(input)).toBe(idempotencyKey(input))
  })

  it('changes when a deliberate re-attempt is intended', () => {
    const base = { tenantId: 't1', operation: 'shipment.book', entityId: 'ord_9' }
    expect(idempotencyKey({ ...base, attemptEpoch: 1 })).not.toBe(idempotencyKey(base))
  })

  it('isolates tenants — two tenants can share an order number', () => {
    const a = idempotencyKey({ tenantId: 't1', operation: 'x', entityId: 'ORD-001' })
    const b = idempotencyKey({ tenantId: 't2', operation: 'x', entityId: 'ORD-001' })
    expect(a).not.toBe(b)
  })

  it('rejects parts that would corrupt the delimiter', () => {
    expect(() => idempotencyKey({ tenantId: 't|1', operation: 'x', entityId: 'y' })).toThrow()
    expect(() => idempotencyKey({ tenantId: '', operation: 'x', entityId: 'y' })).toThrow()
  })
})

describe('webhook de-duplication ids', () => {
  it('namespaces by provider so two providers cannot collide', () => {
    expect(webhookEventId('xendit', 'evt_1')).toBe('xendit:evt_1')
    expect(webhookEventId('jnt', 'evt_1')).not.toBe(webhookEventId('xendit', 'evt_1'))
  })

  it('composes an id for providers that do not send one', () => {
    expect(syntheticWebhookEventId('jnt', ['WB123', 'DELIVERED', 1750000000])).toBe(
      'jnt:WB123:DELIVERED:1750000000',
    )
  })

  it('rejects empty input', () => {
    expect(() => webhookEventId('xendit', '')).toThrow()
    expect(() => syntheticWebhookEventId('jnt', [])).toThrow()
  })
})

describe('ProviderRegistry', () => {
  interface Fake {
    readonly id: 'jnt' | 'flash'
    label: string
  }

  it('registers and resolves', () => {
        const registry = new ProviderRegistry<'jnt' | 'flash', Fake>('courier')
    registry.register({ id: 'jnt', label: 'J&T Express' })
    expect(registry.get('jnt').label).toBe('J&T Express')
    expect(registry.has('jnt')).toBe(true)
    expect(registry.ids()).toEqual(['jnt'])
  })

  it('throws a useful error for an unknown id', () => {
    const registry = new ProviderRegistry<'jnt' | 'flash', Fake>('courier')
    registry.register({ id: 'jnt', label: 'J&T' })
    expect(() => registry.get('flash')).toThrow(/Unknown courier provider "flash".*jnt/s)
  })

  it('refuses duplicate registration — competing credentials are a real bug', () => {
    const registry = new ProviderRegistry<'jnt' | 'flash', Fake>('courier')
    registry.register({ id: 'jnt', label: 'A' })
    expect(() => registry.register({ id: 'jnt', label: 'B' })).toThrow(/already registered/)
  })

  it('reports no registrations gracefully', () => {
    const registry = new ProviderRegistry<'jnt' | 'flash', Fake>('courier')
    expect(() => registry.get('jnt')).toThrow(/\(none\)/)
    expect(registry.all()).toEqual([])
  })
})

describe('IntegrationError', () => {
  it('carries retryability and context', () => {
    const error = IntegrationError.transient('upstream down', {
      ...ctx,
      statusCode: 503,
      requestId: 'req_1',
    })
    expect(error.isRetryable).toBe(true)
    expect(error.kind).toBe('transient')
    expect(error.context.statusCode).toBe(503)
    expect(error).toBeInstanceOf(Error)
  })

  it('marks non-transient kinds as non-retryable', () => {
    expect(IntegrationError.permanent('nope', ctx).isRetryable).toBe(false)
    expect(IntegrationError.auth('nope', ctx).isRetryable).toBe(false)
    expect(IntegrationError.duplicate('exists', ctx).isRetryable).toBe(false)
  })
})
