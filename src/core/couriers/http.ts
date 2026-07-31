import { IntegrationError } from '@/core/integration/errors'

/**
 * The HTTP plumbing both courier providers share.
 *
 * Extracted because the *classification* is the part that matters and it must not
 * drift between couriers: whether a failure is transient decides whether a parcel
 * lands in the retry queue or in front of the seller, and two providers disagreeing
 * about what a 429 means is two different operational behaviours for one word.
 *
 * Adding LBC or Ninja Van should be a new file that calls this, plus one registry
 * line — see src/core/README.md.
 */

export interface CourierHttpOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Map a courier's HTTP response onto the retryable/terminal distinction.
 *
 * The 4xx-except-429 rule is the load-bearing one. An unserviceable barangay comes
 * back as a 400 and will come back as a 400 forever; retrying it four times with
 * backoff delays the *other* 39 parcels in the batch and tells the seller nothing
 * new. A 503 is the opposite.
 */
export function classifyCourierError(
  provider: string,
  endpoint: string,
  status: number,
  body: string,
): IntegrationError {
  const context = { provider, endpoint, statusCode: status }
  if (status === 401 || status === 403) {
    return new IntegrationError('auth', `${provider} rejected the credentials`, context)
  }
  if (status === 409) {
    // The idempotency key worked: this request has already been accepted. Callers
    // treat it as a success they simply already had.
    return new IntegrationError('duplicate', `${provider} has this booking already`, context)
  }
  if (status === 429 || status >= 500) {
    return new IntegrationError('transient', `${provider} returned ${status}`, context)
  }
  return new IntegrationError(
    'permanent',
    `${provider} rejected the request: ${body.slice(0, 300)}`,
    context,
  )
}

export async function courierFetch<T>(
  options: Required<Omit<CourierHttpOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch },
  provider: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await options.fetchImpl(`${options.baseUrl}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })

    const text = await response.text()
    if (!response.ok) throw classifyCourierError(provider, path, response.status, text)
    return (text === '' ? {} : JSON.parse(text)) as T
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    // A timeout is the dangerous case: the courier may well have created the
    // parcel. It is classified transient so the retry happens — and the retry is
    // safe only because the idempotency key is derived from the order, so the
    // courier recognises it as the same request rather than booking a second one.
    throw new IntegrationError('transient', `${provider} call failed: ${String(error)}`, {
      provider,
      endpoint: path,
    })
  } finally {
    clearTimeout(timer)
  }
}
