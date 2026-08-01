import { scrub, scrubText, scrubUrl } from './scrub'

/**
 * Error reporting, to a Sentry-compatible endpoint.
 *
 * ## Why this is ~120 lines rather than `@sentry/react`
 *
 * The SDK's *default* is to send the URL, the request headers, the cookies, the
 * breadcrumb trail of every fetch, and — with one option flipped — the form body.
 * On this platform every one of those carries a buyer's phone number, an address,
 * or a cart token that is a session. Getting an SDK to send less than it wants to
 * means auditing its `beforeSend`, its integrations, its breadcrumbs and its
 * defaults on every upgrade, and the failure mode of getting it wrong is a
 * personal-data breach with a copy on somebody else's servers.
 *
 * Writing the envelope by hand is a day of work once. It also means the thing
 * that decides what leaves the process is `scrub.ts`, which has tests naming
 * every value that must never appear.
 *
 * It is the same shape of decision as `server/billing-routes.ts` calling Xendit's
 * REST API directly: the integration is small, the correctness is ours.
 *
 * ## Sampling and failure
 *
 * Reporting never throws and never awaits anything the caller depends on. An
 * error while reporting an error is a loop, and a seller's checkout must not fail
 * because our telemetry endpoint is down.
 */

export interface TelemetryConfig {
  /** Sentry DSN. Absent disables reporting entirely. */
  dsn: string
  environment: string
  release?: string
  /** 0..1. Errors are cheap and rare; the default sends all of them. */
  sampleRate?: number
  fetchImpl?: typeof fetch
}

interface Dsn {
  endpoint: string
  publicKey: string
}

/**
 * `https://KEY@o123.ingest.sentry.io/456` → the envelope endpoint.
 *
 * Parsed rather than configured as two variables, because the DSN is the string
 * operators actually copy out of the dashboard, and asking them to split it is
 * asking for a mismatched pair.
 */
export function parseDsn(dsn: string): Dsn | null {
  try {
    const url = new URL(dsn)
    const projectId = url.pathname.replace(/^\/+/, '')
    if (url.username === '' || projectId === '') return null
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
    }
  } catch {
    return null
  }
}

let config: TelemetryConfig | null = null
let parsed: Dsn | null = null

/**
 * Install the reporter. Called once at startup, never at import time — the same
 * rule the provider registries follow, so a test can install nothing.
 */
export function initTelemetry(next: TelemetryConfig | null): void {
  config = next
  parsed = next === null ? null : parseDsn(next.dsn)
}

export interface ReportContext {
  /** Where it happened. Scrubbed before it is sent. */
  url?: string
  /** Anything that helps. Deep-scrubbed; see `scrub.ts`. */
  extra?: Record<string, unknown>
  /** `error` unless the caller means otherwise. */
  level?: 'error' | 'warning' | 'info'
  /** Groups related failures. Never a value — a value would be personal data. */
  tags?: Record<string, string>
}

function frames(stack: string | undefined): { filename: string; function: string }[] {
  if (stack === undefined) return []
  return stack
    .split('\n')
    .slice(1, 30)
    .map((line) => {
      const match = /at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?$/.exec(line.trim())
      return {
        function: match?.[1] ?? '?',
        // A stack frame is a file path, and in a dev build a file path can be a
        // URL with a query. Scrub it like any other.
        filename: scrubUrl(match?.[2] ?? line.trim()),
      }
    })
    .reverse()
}

/**
 * Report an error. Fire and forget, always.
 *
 * Returns the envelope it sent (or null) so a test can assert on what left the
 * process rather than on what was passed in — which is the only assertion worth
 * making about a scrubber.
 */
export function reportError(error: unknown, context: ReportContext = {}): unknown | null {
  if (config === null || parsed === null) return null
  if (Math.random() > (config.sampleRate ?? 1)) return null

  const err = error instanceof Error ? error : null
  const envelope = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: context.level ?? 'error',
    environment: config.environment,
    ...(config.release === undefined ? {} : { release: config.release }),
    tags: context.tags ?? {},
    // Deliberately absent: `request.headers`, `request.cookies`, `user`. There is
    // no version of those that is safe to send from this product.
    request: context.url === undefined ? undefined : { url: scrubUrl(context.url) },
    exception: {
      values: [
        {
          type: err?.name ?? 'Error',
          value: scrubText(err?.message ?? String(error)),
          stacktrace: { frames: frames(err?.stack) },
        },
      ],
    },
    extra: context.extra === undefined ? undefined : (scrub(context.extra) as object),
  }

  const body =
    `${JSON.stringify({ event_id: envelope.event_id, sent_at: new Date().toISOString() })}\n` +
    `${JSON.stringify({ type: 'event' })}\n` +
    `${JSON.stringify(envelope)}\n`

  const send = config.fetchImpl ?? globalThis.fetch
  try {
    void send(parsed.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}`,
      },
      body,
      keepalive: true,
    }).catch(() => {
      /* An error while reporting an error is a loop. */
    })
  } catch {
    /* Same. */
  }
  return envelope
}

/**
 * Catch what nobody caught.
 *
 * Installed on the dashboard only. The storefront is server-rendered and its
 * hydration is deliberately deferred; wiring a global handler there would mean
 * shipping this module in a buyer's bundle to report an error that, by design,
 * cannot stop them reading the page.
 */
export function installGlobalHandlers(target: Window): void {
  target.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, { url: target.location.href, tags: { kind: 'window' } })
  })
  target.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { url: target.location.href, tags: { kind: 'promise' } })
  })
}
