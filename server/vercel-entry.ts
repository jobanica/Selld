import type { IncomingMessage, ServerResponse } from 'node:http'

import { createRequestHandler } from './storefront-server'

/**
 * The whole app, as one Vercel Function.
 *
 * The storefront is server-rendered — that is phase 5's entire argument, and an
 * LCP < 2.0s on 3G budget a client-rendered page cannot meet — so it needs a
 * server. Vercel does not run a long-lived process, so the same request handler
 * that `pnpm start` puts behind `createServer()` is exported here instead and
 * invoked per request.
 *
 * Static files never reach this. Vercel checks the filesystem before applying
 * the rewrite in vercel.json, so `/assets/*`, the service worker and the
 * manifest are served directly from `dist/client`.
 *
 * The handler is built once per cold start and reused: `productionSetup()` reads
 * the Vite manifest and the storefront's stylesheet off disk, and doing that per
 * request would put a syscall in front of every buyer.
 */
let handler: Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> | null = null

export default async function vercelHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  handler ??= createRequestHandler()
  try {
    await (await handler)(request, response)
  } catch (error) {
    // A failure while *building* the handler must not be cached as a poisoned
    // promise — the next request would get the same rejection forever, long
    // after a bad deploy was rolled back.
    handler = null
    console.error('[storefront] unhandled', error)
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    response.end('Internal Server Error')
  }
}
