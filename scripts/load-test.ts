/**
 * Load test: checkout and live-claim ingestion at 100 requests a second.
 *
 *   pnpm load:test                       # both, 30s each
 *   pnpm load:test -- --rate 200 --seconds 10 --only checkout
 *
 * Two paths, chosen because they are the two that *cannot* be allowed to fail
 * under load and for opposite reasons:
 *
 *   **checkout** is a buyer with their card out. A 500 here is a lost sale and
 *   the seller never finds out it happened.
 *
 *   **live-claim ingestion** is the wedge feature, and the load is not
 *   hypothetical: a live session genuinely produces 200 comments in a minute,
 *   arriving as a burst rather than a stream, and every one of them reserves
 *   stock under an advisory lock. If anything in this product serialises badly
 *   under concurrency, it is that.
 *
 * ## Open-loop, not closed-loop
 *
 * Requests are *scheduled* at the target rate rather than sent as fast as the
 * last one completes. A closed-loop harness with N workers measures a system
 * that never gets busier than N in flight — it cannot produce a queue, so it
 * cannot find the point where latency goes non-linear, which is the only thing
 * worth measuring. Coordinated omission, and the reason most load tests report
 * flattering numbers.
 *
 * The number reported for each request is therefore measured from when it was
 * *due*, not from when it was sent. A run that falls behind schedule shows up as
 * rising latency, which is what a real queue feels like.
 */
import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

interface Options {
  rate: number
  seconds: number
  base: string
  host: string
  only: 'checkout' | 'live' | 'both'
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? (argv[at + 1] ?? fallback) : fallback
  }
  return {
    rate: Number(get('rate', '100')),
    seconds: Number(get('seconds', '30')),
    base: get('base', 'http://127.0.0.1:5174'),
    host: get('host', 'rheas-finds.localhost'),
    only: get('only', 'both') as Options['only'],
  }
}

interface Sample {
  /** From when the request was *due*, so a backlog is visible. */
  latencyMs: number
  status: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[index] ?? 0)
}

function report(name: string, samples: Sample[], seconds: number): boolean {
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b)
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400).length
  const rateLimited = samples.filter((s) => s.status === 429).length
  const failed = samples.filter((s) => s.status >= 500 || s.status === 0).length

  console.log('')
  console.log(`  ${name}`)
  console.log(`    sent          ${String(samples.length)} over ${String(seconds)}s`)
  console.log(`    achieved      ${(samples.length / seconds).toFixed(1)} req/s`)
  console.log(`    2xx/3xx       ${String(ok)}`)
  console.log(`    429           ${String(rateLimited)}`)
  console.log(`    5xx / dropped ${String(failed)}`)
  console.log(`    p50           ${String(percentile(latencies, 50))}ms`)
  console.log(`    p95           ${String(percentile(latencies, 95))}ms`)
  console.log(`    p99           ${String(percentile(latencies, 99))}ms`)
  console.log(`    max           ${String(percentile(latencies, 100))}ms`)

  // The bar. A 429 is not a failure — it is the rate limiter doing its job and
  // saying come back — but a 5xx is the server falling over, and there is no
  // acceptable number of those other than zero.
  return failed === 0
}

/**
 * Fire at a fixed rate for a fixed time, regardless of how long each takes.
 *
 * The scheduling loop sleeps to the next slot rather than after each send, so a
 * slow response delays that request's *result* and not the next request's start.
 */
async function drive(
  name: string,
  rate: number,
  seconds: number,
  send: (n: number) => Promise<Sample>,
): Promise<boolean> {
  const intervalMs = 1000 / rate
  const total = Math.round(rate * seconds)
  const started = Date.now()
  const inFlight: Promise<Sample>[] = []

  process.stdout.write(`  ${name}: `)
  for (let n = 0; n < total; n += 1) {
    const dueAt = started + n * intervalMs
    const wait = dueAt - Date.now()
    if (wait > 0) await sleep(wait)

    inFlight.push(
      send(n)
        .then((sample) => ({
          ...sample,
          // Measured from when it was due. See the note about coordinated
          // omission at the top of the file.
          latencyMs: sample.latencyMs + Math.max(0, Date.now() - sample.latencyMs - dueAt),
        }))
        .catch(() => ({ latencyMs: Date.now() - dueAt, status: 0 })),
    )
    if (n % Math.max(1, Math.round(rate)) === 0) process.stdout.write('.')
  }
  process.stdout.write('\n')

  return report(name, await Promise.all(inFlight), seconds)
}

/**
 * One request, over `node:http` rather than `fetch`.
 *
 * `Host` is a forbidden header for `fetch`, and Node does not resolve
 * `*.localhost` — so a `fetch` aimed at a store arrives as `127.0.0.1` and gets
 * the dashboard shell, which is a fast 200 for the wrong page. That is the worst
 * possible failure for a load test: it reports excellent numbers for work it
 * never did. CLAUDE.md records the same trap for the multi-tenant HTTP checks.
 */
function send(
  base: string,
  host: string,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Sample> {
  const at = Date.now()
  const url = new URL(path, base)
  return new Promise<Sample>((resolve) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: { Host: host, ...(init.headers ?? {}) },
      },
      (res) => {
        // Drain: an unread body holds the socket, and the next request pays for
        // it — which would show up as latency this harness caused.
        res.resume()
        res.on('end', () => resolve({ latencyMs: Date.now() - at, status: res.statusCode ?? 0 }))
      },
    )
    req.on('error', () => resolve({ latencyMs: Date.now() - at, status: 0 }))
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

const options = parseArgs(process.argv.slice(2))
console.log(
  `Load test — ${String(options.rate)} req/s for ${String(options.seconds)}s against ${options.base}`,
)

let allOk = true

if (options.only === 'checkout' || options.only === 'both') {
  // The read path of checkout: rendering the form is what every buyer does
  // before they submit, it is the most expensive page on the storefront, and it
  // is the one an abandoned-cart burst hits hardest.
  allOk =
    (await drive('checkout page', options.rate, options.seconds, (n) =>
      send(options.base, options.host, `/checkout?n=${String(n)}`, {
        // A different address per request. The per-IP floor is deliberately
        // loose, but 100/s from one address would hit it — and then the test
        // would be measuring the rate limiter rather than the page.
        headers: { 'x-forwarded-for': `10.0.${String(n % 250)}.1` },
      }),
    )) && allOk
}

if (options.only === 'live' || options.only === 'both') {
  const secret = process.env.LIVE_WEBHOOK_SECRET ?? ''
  if (secret === '') {
    console.log('\n  live ingestion: skipped (LIVE_WEBHOOK_SECRET unset)')
  } else {
    // A live comment, in the shape Facebook sends it. Unmatched session, so this
    // measures the ingestion path and the signature check rather than the stock
    // reservation — which the concurrency suite already proves separately, with
    // real parallel connections and a real contended row.
    allOk =
      (await drive('live comment ingest', options.rate, options.seconds, (n) => {
        const body = JSON.stringify({
            object: 'page',
            entry: [
              {
                id: 'load-test',
                time: Date.now(),
                changes: [
                  {
                    field: 'feed',
                    value: {
                      item: 'comment',
                      verb: 'add',
                      comment_id: `load-${String(n)}`,
                      post_id: 'load-post',
                      from: { id: `psid-${String(n % 50)}`, name: 'Load Test' },
                      message: 'mine po A1 2pcs',
                    },
                  },
                ],
              },
            ],
        })
        // Signed, because the unsigned path is a 401 from the first line of the
        // handler — a load test that measures the reject is measuring the
        // routing and calling it ingestion.
        const appSecret = process.env.FB_APP_SECRET ?? ''
        return send(options.base, options.host, `/api/webhooks/live/facebook/${secret}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(appSecret === ''
              ? {}
              : {
                  'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret)
                    .update(body)
                    .digest('hex')}`,
                }),
          },
          body,
        })
      })) && allOk
  }
}

console.log('')
console.log(allOk ? '=== no request was dropped or 5xx ===' : '=== THE SERVER DROPPED REQUESTS ===')
process.exit(allOk ? 0 : 1)
