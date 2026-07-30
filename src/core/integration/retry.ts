import { IntegrationError } from './errors'

/**
 * Exponential backoff with full jitter, per the hard rule that every external
 * call is retried with backoff and logged.
 *
 * Jitter is not optional here. Courier bulk booking fires 40 requests at once;
 * without jitter, a transient 503 makes all 40 retry on the same schedule and
 * the retry storm looks like an attack to the provider.
 */

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number
  /** Delay before the first retry, in ms. Default 500. */
  baseDelayMs?: number
  /** Ceiling for any single delay, in ms. Default 8000. */
  maxDelayMs?: number
  /** Injected for tests. Defaults to `Math.random`. */
  random?: () => number
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Called before each retry — wire this to `integration_logs`. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
  /** Override the retry decision. Defaults to {@link isRetryable}. */
  shouldRetry?: (error: unknown) => boolean
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Retry unless the error is explicitly classified as non-transient. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof IntegrationError) return error.isRetryable
  // An unclassified failure is usually a network/DNS blip, which is retryable.
  return true
}

/**
 * Delay for a given retry, using full jitter: `random(0, min(cap, base * 2^n))`.
 * Exposed for tests and for the booking-failure queue in phase 10, which needs
 * the same curve across process restarts.
 */
export function backoffDelayMs(
  attempt: number,
  { baseDelayMs = 500, maxDelayMs = 8_000, random = Math.random }: RetryOptions = {},
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.round(random() * exponential)
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 4,
    sleep = defaultSleep,
    onRetry,
    shouldRetry = isRetryable,
  } = options

  if (attempts < 1) throw new RangeError('withRetry requires at least 1 attempt')

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      const isLastAttempt = attempt === attempts
      if (isLastAttempt || !shouldRetry(error)) throw error

      // Honour a provider's Retry-After over our own curve when it is longer.
      const hinted =
        error instanceof IntegrationError ? error.context.retryAfterMs : undefined
      const delayMs = Math.max(backoffDelayMs(attempt, options), hinted ?? 0)

      onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }

  throw lastError
}
