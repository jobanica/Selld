/**
 * Error taxonomy for third-party calls.
 *
 * The distinction that matters operationally is *retryable vs terminal*. A J&T
 * booking that fails on a 503 should land in the retry queue; one that fails
 * because the barangay is unserviceable must surface to the seller immediately.
 * Collapsing those two into a generic Error is how sellers end up with parcels
 * silently unbooked.
 */

export type IntegrationErrorKind =
  /** Network failure, timeout, 5xx, 429 — safe and correct to retry. */
  | 'transient'
  /** Bad request, validation failure, unserviceable address — retrying cannot help. */
  | 'permanent'
  /** Bad or expired credentials — needs seller or operator action. */
  | 'auth'
  /** Provider says the resource already exists (a successful idempotent replay). */
  | 'duplicate'

export interface IntegrationErrorContext {
  provider: string
  endpoint: string
  statusCode?: number
  providerCode?: string
  requestId?: string
  /** Provider-supplied retry hint, in milliseconds. */
  retryAfterMs?: number
}

export class IntegrationError extends Error {
  readonly kind: IntegrationErrorKind
  readonly context: IntegrationErrorContext

  constructor(
    kind: IntegrationErrorKind,
    message: string,
    context: IntegrationErrorContext,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'IntegrationError'
    this.kind = kind
    this.context = context
  }

  get isRetryable(): boolean {
    return this.kind === 'transient'
  }

  static transient(
    message: string,
    context: IntegrationErrorContext,
    options?: { cause?: unknown },
  ): IntegrationError {
    return new IntegrationError('transient', message, context, options)
  }

  static permanent(
    message: string,
    context: IntegrationErrorContext,
    options?: { cause?: unknown },
  ): IntegrationError {
    return new IntegrationError('permanent', message, context, options)
  }

  static auth(
    message: string,
    context: IntegrationErrorContext,
    options?: { cause?: unknown },
  ): IntegrationError {
    return new IntegrationError('auth', message, context, options)
  }

  static duplicate(
    message: string,
    context: IntegrationErrorContext,
    options?: { cause?: unknown },
  ): IntegrationError {
    return new IntegrationError('duplicate', message, context, options)
  }
}

/**
 * Classify an HTTP status into a retry decision.
 *
 * 409 is treated as `duplicate` rather than an error: with idempotency keys in
 * play, a conflict usually means our previous attempt actually succeeded.
 */
export function classifyStatus(status: number): IntegrationErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 409) return 'duplicate'
  if (status === 408 || status === 425 || status === 429) return 'transient'
  if (status >= 500) return 'transient'
  return 'permanent'
}
