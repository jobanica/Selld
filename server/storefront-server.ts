import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

import type { render as renderStorefront } from '../src/storefront/entry-server'
import { resolveSurface, storeHref } from '../src/lib/tenant/resolve-tenant'
import type { CheckoutAddress, CheckoutContact } from '../src/storefront/cart-data'
import {
  EMPTY_PSGC_OPTIONS,
  isOnlineMethod,
  type CartPageData,
  type OnlineMethod,
  type TrackingPayload,
} from '../src/storefront/cart-data'
import type { StorefrontPage } from '../src/storefront/storefront-root'
import type { HomePayload, PageData, ProductPayload } from '../src/storefront/storefront-data'
import {
  fetchPsgcOptions,
  fetchQuote,
  fetchQuoteForAddress,
  fetchReceipt,
  handleCartAdd,
  handleCartQty,
  handleCheckoutPost,
  parseCookies,
  readRememberedCheckout,
  type StoreRef,
} from './cart-routes'
import { CART_COOKIE, cartCookie, isSecureRequest } from './cookies'
import { serveCourierRoutes } from './courier-routes'
import { readServiceConfig, serveXenditWebhook } from './payment-webhook'
import { serveLiveWebhook } from './live-routes'
import { serveBroadcastRoutes, serveShortLink } from './broadcast-routes'
import {
  registerMarketplaceProviders,
  serveMarketplaceRoutes,
  startMarketplaceWorker,
} from './marketplace-routes'
import { serveSocialRoutes, serveSocialWebhook } from './social-routes'
import { clientIp, guard, startRateLimitSweeper } from './rate-limit'
import { initTelemetry, reportError } from '@/lib/telemetry/report-error'
import {
  readPlatformBillingConfig,
  serveBillingRoutes,
  serveBillingWebhook,
  startBillingWorker,
} from './billing-routes'
import { serveCourierWebhook } from './tracking'
import { readSupabaseConfig, rpc, type SupabaseConfig } from './supabase-rpc'

/**
 * The storefront server.
 *
 * Why a server at all, when phases 0–4 shipped a static SPA: the storefront
 * carries an LCP < 2.0s on 3G budget, and a client-rendered page cannot meet it.
 * A CSR load is four sequential steps — HTML, JS, boot, then the data fetch —
 * before anything paints, and on a 150ms-RTT link the round trips alone exceed
 * the budget. Server rendering collapses that to one round trip for a document
 * that is already complete.
 *
 * The dashboard stays client-rendered. It is behind auth, invisible to crawlers,
 * and its users are repeat visitors with a warm cache — SSR would add deployment
 * complexity to solve a problem it does not have.
 *
 * Prerendering at build time was the other option the brief allowed, and it does
 * not work here: stores are created by sellers at runtime, so the set of pages is
 * not known when the build runs.
 */

/**
 * Where `dist/` lives.
 *
 * Normally the repository root, one level above this file. A serverless bundle
 * rearranges that — the handler is invoked from a task directory whose layout is
 * the platform's business, not ours — so fall back to the working directory when
 * the build output is not where the module path says it should be. Getting this
 * wrong is a 500 on every request with a stack trace that blames a missing file
 * rather than a wrong prefix.
 */
const ROOT = (() => {
  const candidates = [
    resolve(fileURLToPath(new URL('..', import.meta.url))),
    process.cwd(),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'dist/client/index.html'))) ?? candidates[0]!
})()
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const PORT = Number.parseInt(process.env.PORT ?? '5174', 10)
const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? process.env.VITE_APP_ROOT_DOMAIN ?? 'selld.ph'

interface Renderer {
  render: typeof renderStorefront
}

interface RenderContext {
  supabase: SupabaseConfig
  loadRenderer: () => Promise<Renderer>
  assets: () => Assets
  middlewares: Middlewares
  transformHtml: TransformHtml
}

interface Assets {
  scripts: string[]
  styles: string[]
  /** Stylesheet contents, inlined in production. */
  inlineCss: string
}

/**
 * Dev-only HTML post-processing.
 *
 * Vite has to inject its client and — for @vitejs/plugin-react — the React Refresh
 * preamble. Hand-built HTML skips that, and the failure is quietly total: the
 * preamble is missing, so the client module throws "can't detect preamble", so
 * hydration never runs, so the CSS (which dev serves *through* the module graph)
 * never lands either. The page renders as unstyled HTML with a dead variant
 * picker, and nothing in the server log says so.
 *
 * In production this is the identity function: the build already emitted real
 * script and stylesheet URLs.
 */
type TransformHtml = (url: string, html: string) => Promise<string>

/**
 * Build a request handler without listening on a port.
 *
 * Serverless hosts import a module and call a function per request; there is no
 * process to own a socket, and the background loops below would each be started
 * and frozen again on every invocation. So the wiring is split: this returns the
 * handler, `main()` adds the socket and the workers.
 */
export async function createRequestHandler(): Promise<
  (request: IncomingMessage, response: ServerResponse) => Promise<void>
> {
  const supabase = readSupabaseConfig()
  if (supabase === null) throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY')

  const { loadRenderer, assets, middlewares, transformHtml } = await productionSetup()
  initTelemetry(
    process.env.SENTRY_DSN === undefined || process.env.SENTRY_DSN === ''
      ? null
      : { dsn: process.env.SENTRY_DSN, environment: process.env.VITE_APP_ENV ?? 'production' },
  )
  registerMarketplaceProviders()

  return (request, response) =>
    handle(request, response, { supabase, loadRenderer, assets, middlewares, transformHtml })
}

async function main() {
  const supabase = readSupabaseConfig()
  if (supabase === null) {
    console.error(
      'Missing SUPABASE_URL / SUPABASE_ANON_KEY (VITE_-prefixed names also accepted).\n' +
        'Copy .env.example to .env.local and fill it in, or run `pnpm db:start`.',
    )
    process.exit(1)
  }

  const { loadRenderer, assets, middlewares, transformHtml } = IS_PRODUCTION
    ? await productionSetup()
    : await developmentSetup()

  const server = createServer((request, response) => {
    void handle(request, response, {
      supabase,
      loadRenderer,
      assets,
      middlewares,
      transformHtml,
    }).catch(
      (error: unknown) => {
        console.error('[storefront] unhandled', error)
        reportError(error, { url: request.url ?? '/', tags: { surface: 'storefront' } })
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        }
        response.end('Internal Server Error')
      },
    )
  })

  // Stock pushes are a background loop rather than a reaction to a request:
  // nothing HTTP happens when a buyer reserves the last unit, and the deadline
  // is measured from that moment. Started only where the service role exists,
  // because without it there is nothing the worker could do but log failures.
  // Server-side reporting uses the same envelope and the same scrubber as the
  // browser. A stack trace from the SSR renderer carries exactly the same buyer
  // data as one from the client, and there is no reason for two policies.
  initTelemetry(
    process.env.SENTRY_DSN === undefined || process.env.SENTRY_DSN === ''
      ? null
      : { dsn: process.env.SENTRY_DSN, environment: process.env.VITE_APP_ENV ?? 'development' },
  )

  registerMarketplaceProviders()
  const service = readServiceConfig()
  if (service !== null) startMarketplaceWorker(service)

  // Platform billing runs on the same loop, and is started only when Selld's own
  // gateway credentials are present. A developer looking at a product page should
  // not need the key that can charge cards.
  const billing = readPlatformBillingConfig()
  if (service !== null && billing !== null) startBillingWorker(service, billing)

  // Rate-limit windows nobody can still be inside. On a timer, never on the
  // request path — the buyer must not pay for our housekeeping.
  if (service !== null) startRateLimitSweeper(service)

  server.listen(PORT, () => {
    console.log(
      `[storefront] ${IS_PRODUCTION ? 'production' : 'dev'} on http://localhost:${PORT}\n` +
        `[storefront] root domain: ${ROOT_DOMAIN}  ·  supabase: ${supabase.url}\n` +
        `[storefront] try: http://rheas-finds.localhost:${PORT}/`,
    )
  })
}

// ---------------------------------------------------------------------------
// Dev vs production wiring
// ---------------------------------------------------------------------------

type Middlewares = ((
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void) | null

async function developmentSetup(): Promise<{
  loadRenderer: () => Promise<Renderer>
  assets: () => Assets
  middlewares: Middlewares
  transformHtml: TransformHtml
}> {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: ROOT,
    appType: 'custom',
    server: { middlewareMode: true },
  })

  return {
    // Loaded per request so an edit to a component is picked up without a
    // restart, which is the entire point of running Vite in middleware mode.
    loadRenderer: async () =>
      (await vite.ssrLoadModule('/src/storefront/entry-server.tsx')) as unknown as Renderer,
    assets: () => ({
      // Only the app entry. `/@vite/client` is injected by transformIndexHtml
      // below — listing it here as well loads it twice.
      scripts: ['/src/storefront/entry-client.tsx'],
      styles: [],
      inlineCss: '',
    }),
    middlewares: vite.middlewares,
    transformHtml: (url, html) => vite.transformIndexHtml(url, html),
  }
}

async function productionSetup(): Promise<{
  loadRenderer: () => Promise<Renderer>
  assets: () => Assets
  middlewares: Middlewares
  transformHtml: TransformHtml
}> {
  const serverEntry = join(ROOT, 'dist/server/entry-server.js')
  const manifestPath = join(ROOT, 'dist/client/.vite/manifest.json')

  if (!existsSync(serverEntry) || !existsSync(manifestPath)) {
    throw new Error(`Build output missing under ${ROOT}. Run \`pnpm build\` first.`)
  }

  const renderer = (await import(serverEntry)) as unknown as Renderer
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest

  const entryKey = 'src/storefront/entry-client.tsx'
  if (manifest[entryKey] === undefined) {
    throw new Error('Storefront entry missing from the Vite manifest.')
  }

  const cssFiles = collectCss(manifest, entryKey)
  if (cssFiles.length === 0) {
    // Fail loudly. An unstyled storefront still returns 200 and still contains
    // every word of its content, so nothing downstream notices — and this exact
    // bug shipped once already, because the entry's own `css` array is empty.
    throw new Error(
      `No stylesheet reachable from ${entryKey} in the Vite manifest. ` +
        'The storefront would render unstyled.',
    )
  }

  const styles = cssFiles.map((file) => `/${file}`)
  // Read once at boot, not per request. The storefront's CSS is small enough to
  // inline (see the comment at buildDocument) and re-reading it for every buyer
  // would turn a fast page into a syscall per request.
  const inlineCss = cssFiles
    .map((file) => readFileSync(join(ROOT, 'dist/client', file), 'utf8'))
    .join('')

  const resolved: Assets = { scripts: [`/${manifest[entryKey].file}`], styles, inlineCss }
  return {
    loadRenderer: () => Promise.resolve(renderer),
    assets: () => resolved,
    middlewares: null,
    transformHtml: (_url, html) => Promise.resolve(html),
  }
}

interface ManifestChunk {
  file: string
  css?: string[]
  imports?: string[]
  dynamicImports?: string[]
}

type Manifest = Record<string, ManifestChunk>

/**
 * Every stylesheet reachable from an entry, transitively.
 *
 * Reading `manifest[entry].css` alone is wrong and quietly so: Rollup attributes
 * CSS to the chunk that actually imports it, and because the dashboard and the
 * storefront share a vendor chunk, Tailwind's single sheet lands on *that* chunk
 * rather than on either entry. The entry's own `css` array is empty, so the
 * naive read produced a production storefront with no styling at all — which
 * still returns 200 with all its content present, and so looks fine to every
 * check that is not a pair of eyes.
 */
function collectCss(manifest: Manifest, entry: string): string[] {
  const seen = new Set<string>()
  const css: string[] = []

  const walk = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (chunk === undefined) return
    for (const file of chunk.css ?? []) {
      if (!css.includes(file)) css.push(file)
    }
    // Static imports only. A dynamic import's CSS is loaded by the browser when
    // that chunk is actually requested; inlining it here would ship styles for
    // code this page may never run.
    for (const next of chunk.imports ?? []) walk(next)
  }

  walk(entry)
  return css
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  context: RenderContext,
): Promise<void> {
  const host = (request.headers.host ?? '').toLowerCase()
  const hostname = host.split(':')[0] ?? ''
  const url = new URL(request.url ?? '/', `http://${host || 'localhost'}`)

  /**
   * The floor under everything below.
   *
   * Every public path gets a tighter, better-keyed limit at its own call site;
   * this one exists for the paths that have no better key than the address, and
   * so that a flood on a path nobody thought about still costs something. It is
   * deliberately loose: a mobile network hands one address to a whole city, so
   * the number here has to fit a barangay of shoppers rather than one person.
   *
   * Static assets are excluded. They are cached, they are cheap, and counting
   * them would mean one page load spent a tenth of the budget.
   *
   * So is everything under `/api/`, and that exclusion is load-bearing rather
   * than cosmetic. A webhook provider *is* one address — Facebook posts from a
   * handful of them — so a per-address floor applied to `/api/` makes the floor
   * the binding constraint and the endpoint's own, better-keyed limit
   * decorative. The load test found this immediately: live ingestion was
   * refused at exactly the storefront floor while its own 6,000/min counter sat
   * at 600. Every `/api/` route below guards itself.
   */
  if (
    !isViteAsset(url.pathname) &&
    !url.pathname.startsWith('/assets/') &&
    !url.pathname.startsWith('/api/')
  ) {
    if (await guard(request, response, 'storefront', clientIp(request))) return
  }

  // Webhooks are answered before any surface routing. A provider posts to whatever
  // host was configured — often the apex, which resolves to the dashboard surface —
  // and its delivery must not depend on which store the hostname happens to name.
  // The account is identified by the slug in the path, never by the host.
  if (await serveXenditWebhook(request, response, url.pathname)) return

  // Courier booking is a dashboard action, not a storefront one, but it needs
  // server-held credentials — so it lives on the only Node process there is, and
  // is answered before surface routing for the same reason webhooks are.
  if (await serveCourierRoutes(request, response, url.pathname, context.supabase)) return

  // Courier tracking pushes. Answered before surface routing for the same reason
  // as the payment webhook: a courier posts to whatever host was configured.
  if (await serveCourierWebhook(request, response, url.pathname, storeRootUrl(url))) return

  // Live-selling comments. Same shape as the courier webhook, and answered before
  // surface routing for the same reason: this arrives on the platform's own
  // hostname, not on any seller's store.
  if (await serveLiveWebhook(request, response, url, storeRootUrl(url))) return

  // Page comments and DMs. A separate endpoint from the live webhook because the
  // two do different things with the same shape of payload — one reserves stock
  // against a session's board, the other answers a question under a photo.
  if (await serveSocialWebhook(request, response, url, storeRootUrl(url))) return

  // Connecting a Page, and the OAuth redirect Facebook sends the seller back to.
  if (await serveSocialRoutes(request, response, url, storeRootUrl(url))) return

  // Sending a broadcast, and the short links it carries. Both before surface
  // routing: a short link is tapped from an SMS on whatever host the seller's
  // store answers on, and the send is a dashboard action that needs the
  // server-held service role.
  if (await serveBroadcastRoutes(request, response, url)) return
  if (await serveShortLink(response, url)) return

  // Marketplace mapping and sync. A dashboard action needing server-held
  // credentials, like courier booking, so it lives here for the same reason.
  if (await serveMarketplaceRoutes(request, response, url)) return

  // Selld's own billing: the callback for a seller's subscription or credit pack,
  // and the one dashboard action that needs the platform gateway key. Before
  // surface routing, like every other webhook — it arrives on the platform's
  // hostname and has nothing to do with which store the host names.
  if (await serveBillingWebhook(request, response, url.pathname)) return
  if (await serveBillingRoutes(request, response, url)) return

  // `.localhost` subdomains resolve to 127.0.0.1 in every modern browser, so
  // `rheas-finds.localhost:5174` exercises the real subdomain path in dev.
  const surface = resolveSurface(hostname, {
    rootDomain: hostname.endsWith('.localhost') || hostname === 'localhost' ? 'localhost' : ROOT_DOMAIN,
    pathname: url.pathname,
  })

  // The dashboard is not this server's job — hand it the SPA shell and let the
  // client take over.
  if (surface.kind === 'dashboard') {
    return serveDashboard(request, response, context)
  }

  const slug = surface.kind === 'storefront' ? surface.slug : null
  const domain = surface.kind === 'custom-domain' ? surface.hostname : null

  /**
   * One strip, at the front door.
   *
   * Every route below matches a root-relative path — `/cart`, `/p/{slug}`,
   * `/checkout`, `/track/{n}`. Mounting a store under `/store/{slug}` is
   * therefore a question of *removing* the prefix once here, rather than of
   * teaching thirty route matchers about it and finding out in production which
   * one was missed. It is also what keeps the subdomain form free of any path
   * handling at all: there `basePath` is empty and this is a no-op.
   *
   * Deliberately after the webhook and static branches above, which are platform
   * paths and never carry a store prefix.
   */
  const basePath = surface.basePath
  if (basePath !== '') {
    url.pathname = url.pathname.slice(basePath.length) || '/'
  }

  if (IS_PRODUCTION && (await serveStatic(url.pathname, response))) return

  // Dev: let Vite serve modules, HMR and public assets.
  if (context.middlewares !== null && isViteAsset(url.pathname)) {
    return new Promise<void>((resolveRequest) => {
      context.middlewares!(request, response, () => {
        response.writeHead(404).end()
        resolveRequest()
      })
      response.on('close', () => resolveRequest())
    })
  }

  if (url.pathname === '/robots.txt') {
    return sendText(request, response, robotsTxt(`${url.origin}${basePath}`), 'text/plain; charset=utf-8')
  }

  if (url.pathname === '/sitemap.xml') {
    const sitemap = await buildSitemap(context.supabase, {
      slug,
      domain,
      origin: `${url.origin}${basePath}`,
    })
    if (sitemap === null) return sendNotFoundXml(response)
    return sendText(request, response, sitemap, 'application/xml; charset=utf-8')
  }

  const store: StoreRef = { slug, domain, basePath }

  // ---- Cart and checkout ------------------------------------------------
  // Mutations are POST-only. A cart that can be changed by a GET is a cart that
  // a prefetcher, a crawler or an <img> tag can change.
  if (request.method === 'POST') {
    // Keyed on the cart cookie where there is one. A cart is one buyer, so this
    // throttles the person hammering rather than the network they share — and a
    // caller with no cart yet falls back to the address, which is the only thing
    // known about them.
    const cartKey = parseCookies(request)[CART_COOKIE] ?? clientIp(request)

    if (url.pathname === '/cart/add') {
      if (await guard(request, response, 'cart', cartKey)) return
      return handleCartAdd(request, response, context.supabase, store)
    }
    if (url.pathname === '/cart/qty') {
      if (await guard(request, response, 'cart', cartKey)) return
      return handleCartQty(request, response, context.supabase, store)
    }
    if (url.pathname === '/checkout') {
      if (await guard(request, response, 'checkout', cartKey)) return
      const outcome = await handleCheckoutPost(request, response, context.supabase, store)
      if (outcome.kind === 'redirect') return
      // Re-render the form: either the buyer needs the next address level, or
      // something they entered was rejected.
      return renderCheckout(request, response, context, {
        url,
        store,
        contact: outcome.contact,
        address: outcome.address,
        error: outcome.error,
      })
    }
    response.writeHead(405, { Allow: 'GET' }).end()
    return
  }

  if (url.pathname === '/cart') {
    const token = cartTokenFrom(request)
    const [quote, branding] = await Promise.all([
      fetchQuote(context.supabase, token),
      fetchStoreBranding(context.supabase, store),
    ])
    return renderPage(request, response, context, url, basePath, { route: 'cart', store: branding, quote })
  }

  if (url.pathname === '/checkout') {
    const remembered = readRememberedCheckout(parseCookies(request))
    return renderCheckout(request, response, context, {
      url,
      store,
      contact: {
        name: remembered.name ?? '',
        phone: remembered.phone ?? '',
        email: remembered.email ?? '',
        notes: '',
      },
      address: {
        regionCode: remembered.regionCode ?? '',
        provinceCode: remembered.provinceCode ?? null,
        cityCode: remembered.cityCode ?? '',
        barangayCode: remembered.barangayCode ?? '',
        ...(remembered.street === undefined ? {} : { street: remembered.street }),
        ...(remembered.landmark === undefined ? {} : { landmark: remembered.landmark }),
        ...(remembered.postalCode === undefined ? {} : { postalCode: remembered.postalCode }),
      },
      error: null,
    })
  }

  // ---- A live claim, handed over --------------------------------------
  // The link a buyer gets in Messenger seconds after commenting "mine". It adopts
  // the cart the claim minted and drops them on checkout with the right item
  // already in it — which is the whole difference between a live sale that
  // converts and one where thirty people ask "how po ang bayad".
  //
  // A GET that sets a cookie, deliberately: the buyer is arriving from another
  // app, so there is no form to POST, and the token in the URL *is* the
  // capability. It redirects immediately so the token stops being in the address
  // bar the buyer might screenshot and send to a group chat.
  const claimMatch = /^\/live\/claim\/([0-9a-f]{64})$/.exec(url.pathname)
  if (claimMatch !== null) {
    response.writeHead(303, {
      Location: storeHref(basePath, '/checkout'),
      'Set-Cookie': cartCookie(claimMatch[1]!, isSecureRequest(request)),
      'Cache-Control': 'no-store',
      // Never indexed and never sent onward: the path is a bearer token.
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    })
    response.end()
    return
  }

  // ---- Public order tracking --------------------------------------------
  // No cookie, no login, no account. A buyer opens this from an SMS while
  // standing outside, on whatever phone they have, and it has to work.
  //
  // Scoped to the store the hostname resolves to, so an order number is only ever
  // meaningful on its own seller's storefront — two sellers both have an order
  // `0001` and neither can read the other's.
  const trackMatch = /^\/track\/([A-Za-z0-9][A-Za-z0-9._-]{0,39})\/?$/.exec(url.pathname)
  if (trackMatch !== null) {
    // Keyed on the order number, which is the capability being used. Somebody
    // enumerating numbers gets a fresh bucket per guess and is caught by the
    // per-address floor above instead — the two together are the guard, and
    // neither is on its own.
    if (await guard(request, response, 'tracking', trackMatch[1] ?? '')) return
    const [branding, tracking] = await Promise.all([
      fetchStoreBranding(context.supabase, store),
      fetchTracking(context.supabase, store, trackMatch[1] ?? ''),
    ])
    // No store at this hostname: fall through to the generic not-found below
    // rather than rendering a tracking page with no branding to render it in.
    if (branding !== null) {
      return renderPage(request, response, context, url, basePath, {
        route: 'track',
        store: branding,
        tracking,
      })
    }
  }

  // The privacy notice. On the store's own domain and in the store's locale,
  // because the Act requires the buyer be *informed* — a notice on our marketing
  // site, in English, is not that.
  if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
    const [branding, version] = await Promise.all([
      fetchStoreBranding(context.supabase, store),
      fetchPolicyVersion(context.supabase),
    ])
    if (branding !== null) {
      return renderPage(request, response, context, url, basePath, {
        route: 'privacy',
        store: branding,
        policyVersion: version,
      })
    }
  }

  if (url.pathname === '/order/confirmed') {
    const [receipt, branding] = await Promise.all([
      fetchReceipt(context.supabase, cartTokenFrom(request)),
      fetchStoreBranding(context.supabase, store),
    ])
    // No receipt means no order for this cookie — a bookmarked confirmation, or a
    // cleared cookie. The cart is the honest place to land, not an error.
    if (receipt === null) return redirectTo(response, storeHref(basePath, '/cart'))
    return renderPage(request, response, context, url, basePath, {
      route: 'order-confirmed',
      store: branding,
      receipt,
    })
  }

  const data = await loadPageData(context.supabase, { slug, domain, url, hostname })
  const { render } = await context.loadRenderer()

  const rendered = render({
    data,
    origin: url.origin,
    storageOrigin: context.supabase.url,
    basePath,
    path: `${url.pathname}${url.search}`,
  })

  const document = await context.transformHtml(
    url.pathname,
    buildDocument(rendered, context.assets(), data),
  )
  sendHtml(request, response, document, rendered.status)
}

async function loadPageData(
  supabase: SupabaseConfig,
  input: { slug: string | null; domain: string | null; url: URL; hostname: string },
): Promise<PageData> {
  const { slug, domain, url, hostname } = input
  const productMatch = /^\/p\/([A-Za-z0-9-]{1,120})\/?$/.exec(url.pathname)

  try {
    if (productMatch !== null) {
      const payload = await rpc<ProductPayload | null>(supabase, 'storefront_product_page', {
        p_product_slug: productMatch[1],
        p_slug: slug,
        p_domain: domain,
      })
      if (payload === null) return { route: 'not-found', store: null, hostname }
      return { route: 'product', payload }
    }

    if (url.pathname !== '/') {
      // Unknown path. Still resolve the store so the 404 can be branded.
      const home = await rpc<HomePayload | null>(supabase, 'storefront_home', {
        p_slug: slug,
        p_domain: domain,
        p_limit: 1,
      })
      return { route: 'not-found', store: home?.store ?? null, hostname }
    }

    const category = url.searchParams.get('category')
    const search = url.searchParams.get('q')
    const payload = await rpc<HomePayload | null>(supabase, 'storefront_home', {
      p_slug: slug,
      p_domain: domain,
      p_category: category === null || category.trim() === '' ? null : category.trim(),
      p_search: search === null || search.trim() === '' ? null : search.trim(),
    })

    if (payload === null) return { route: 'not-found', store: null, hostname }
    return {
      route: 'home',
      payload,
      query: {
        category: category === null || category.trim() === '' ? null : category.trim(),
        search: search === null || search.trim() === '' ? null : search.trim(),
      },
    }
  } catch (error) {
    // A database failure must not render a page that says "no such store" — that
    // would tell a seller their shop is gone during an outage. Re-raise so the
    // 500 handler reports the truth.
    console.error('[storefront] data load failed', error)
    throw error
  }
}


// ---------------------------------------------------------------------------
// Cart / checkout rendering
// ---------------------------------------------------------------------------

/**
 * Just the store's branding, for pages that are reached by cookie.
 *
 * `storefront_home` with a page size of 1 rather than a dedicated RPC: the
 * function already returns the store, the product it also returns is one row, and
 * a second function would be a second thing to keep in step with the theme.
 */
/**
 * The version of the notice on this page.
 *
 * Read from the database and cached for the process, so the string the buyer is
 * shown and the string stamped on their consent row are the same string. Falling
 * back to a literal here would record agreement to a version this file invented.
 */
let policyVersionCache: string | null = null
async function fetchPolicyVersion(supabase: SupabaseConfig): Promise<string> {
  if (policyVersionCache !== null) return policyVersionCache
  policyVersionCache = await rpc<string>(supabase, 'privacy_policy_version', {}).catch(
    () => 'unknown',
  )
  return policyVersionCache
}

async function fetchStoreBranding(
  supabase: SupabaseConfig,
  store: StoreRef,
): Promise<HomePayload['store'] | null> {
  const payload = await rpc<HomePayload | null>(supabase, 'storefront_home', {
    p_slug: store.slug,
    p_domain: store.domain,
    p_limit: 1,
  })
  return payload?.store ?? null
}

/**
 * Online methods this store can take right now.
 *
 * Failure is an empty list, not an error: a payments lookup that times out must
 * degrade to COD rather than take down a checkout the buyer could still complete.
 */
async function fetchOnlineMethods(
  supabase: SupabaseConfig,
  store: StoreRef,
): Promise<OnlineMethod[]> {
  try {
    const methods = await rpc<unknown>(supabase, 'storefront_payment_methods', {
      p_slug: store.slug,
      p_domain: store.domain,
    })
    if (!Array.isArray(methods)) return []
    return methods.filter((method): method is OnlineMethod =>
      typeof method === 'string' && isOnlineMethod(method),
    )
  } catch {
    return []
  }
}

/**
 * One order's public tracking state, or null.
 *
 * Failure degrades to null rather than to a 500. The buyer arrived here because a
 * text told them to; a stack trace teaches them that the link is broken and sends
 * them straight back to messaging the seller, which is the exact behaviour this
 * phase exists to remove.
 */
async function fetchTracking(
  supabase: SupabaseConfig,
  store: StoreRef,
  orderNumber: string,
): Promise<TrackingPayload | null> {
  try {
    return await rpc<TrackingPayload | null>(supabase, 'public_tracking', {
      p_slug: store.slug,
      // Explicitly null rather than omitted. PostgREST resolves an overload by
      // the *set of argument names* in the body, and a key JSON.stringify drops
      // is a key PostgREST never sees — the call then 404s against a function
      // that is right there, with a hint naming the signature you meant.
      p_domain: store.domain,
      p_order_number: orderNumber,
    })
  } catch {
    return null
  }
}

/**
 * The platform's own origin, for building links into a *seller's* storefront.
 *
 * Deliberately not `url.origin`. A courier webhook arrives on the platform's
 * webhook hostname, and a tracking link built from that request would point a
 * buyer at the webhook endpoint rather than at the shop they bought from — in
 * dev that showed up as `http://127.0.0.1:5184/track/0001` in an outgoing SMS.
 * `sms_render_for_order` turns this into `{scheme}://{slug}.{host}` (or the
 * store's custom domain), which is the same rule `resolveSurface` applies in
 * the other direction.
 */
function storeRootUrl(url: URL): string {
  // Loopback counts as local too. A courier webhook replayed against a dev
  // server arrives on `127.0.0.1`, and resolving that to the production root
  // domain would put an unreachable link in every test message.
  const local =
    url.hostname.endsWith('.localhost') ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]'
  const host = local ? `localhost${url.port === '' ? '' : `:${url.port}`}` : ROOT_DOMAIN
  return `${url.protocol}//${host}`
}

function cartTokenFrom(request: IncomingMessage): string | null {
  const token = parseCookies(request)[CART_COOKIE]
  return token !== undefined && /^[0-9a-f]{64}$/.test(token) ? token : null
}

function redirectTo(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }).end()
}

/**
 * Render any cart-family page.
 *
 * These are `no-store`, unlike the catalog pages: a cart is per-buyer, and an edge
 * cache that treats it like the product grid would serve one buyer's cart to
 * another.
 */
async function renderPage(
  request: IncomingMessage,
  response: ServerResponse,
  context: RenderContext,
  url: URL,
  basePath: string,
  page: CartPageData,
): Promise<void> {
  const { render } = await context.loadRenderer()
  const rendered = render({
    data: page,
    origin: url.origin,
    storageOrigin: context.supabase.url,
    basePath,
    path: `${url.pathname}${url.search}`,
    cartCount: page.route === 'cart' || page.route === 'checkout' ? (page.quote?.itemCount ?? 0) : 0,
  })
  const document = await context.transformHtml(
    url.pathname,
    buildDocument(rendered, context.assets(), page),
  )
  sendPrivateHtml(request, response, document, rendered.status)
}

async function renderCheckout(
  request: IncomingMessage,
  response: ServerResponse,
  context: RenderContext,
  input: {
    url: URL
    store: StoreRef
    contact: CheckoutContact
    address: Partial<CheckoutAddress>
    error: { field: string; message: string } | null
  },
): Promise<void> {
  const token = cartTokenFrom(request)
  // Priced against the destination the buyer has chosen so far, so the shipping
  // line is the real zone rate rather than the cart page's catch-all estimate.
  const quote = await fetchQuoteForAddress(context.supabase, token, input.address)

  // An empty cart has nothing to check out. Sending the buyer back is kinder than
  // rendering a form that cannot be submitted.
  if (quote === null || quote.itemCount === 0) {
    return redirectTo(response, storeHref(input.store.basePath, '/cart'))
  }

  const [options, branding, onlineMethods] = await Promise.all([
    fetchPsgcOptions(context.supabase, input.address).catch(() => EMPTY_PSGC_OPTIONS),
    fetchStoreBranding(context.supabase, input.store),
    fetchOnlineMethods(context.supabase, input.store),
  ])

  return renderPage(request, response, context, input.url, input.store.basePath, {
    route: 'checkout',
    store: branding,
    quote,
    contact: input.contact,
    address: input.address,
    options,
    error: input.error === null ? null : { field: input.error.field as never, message: input.error.message },
    onlineMethods,
  })
}

function sendPrivateHtml(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  status: number,
): void {
  const { payload, encoding } = compress(request, body)
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...(encoding === null ? {} : { 'Content-Encoding': encoding }),
    Vary: 'Accept-Encoding',
    // Never cached anywhere. This page contains one buyer's cart, and from the
    // checkout step onward their name, phone and address.
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
  response.end(payload)
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function buildDocument(
  rendered: Awaited<ReturnType<Renderer['render']>>,
  assets: Assets,
  data: StorefrontPage,
): string {
  // One accessor for both page shapes. This used to read `data.payload.store`
  // directly, which is right for catalog pages and undefined for cart pages — and
  // the `as never` casts at the two call sites hid the mismatch from the type
  // checker until the cart 500'd at runtime. The casts are gone.
  const store = pageStore(data)
  const lang = store?.locale ?? 'en'
  const themeColor = store?.brandColor ?? null

  // Order matters and is load-bearing: the theme goes AFTER the app stylesheet.
  // index.css declares `--primary` on `:root`, the theme re-declares it on `:root`,
  // and equal specificity means the later rule wins. Emitting the theme first
  // rendered every store in Selld's default green with the seller's real colour
  // sitting inert in the document a few lines above.
  //
  // CSS is inlined rather than linked in production. The whole sheet is ~30KB
  // raw / ~7KB compressed, which is less than the cost of the extra round trip
  // it would take to fetch it — and a linked stylesheet is render-blocking, so
  // that round trip lands directly on LCP. The trade is that it is re-sent with
  // every document instead of being cached separately; at this size, and with the
  // document itself CDN-cacheable, that is the cheaper side.
  const styleTags =
    assets.inlineCss === ''
      ? assets.styles.map((href) => `<link rel="stylesheet" href="${href}" />`).join('')
      : `<style>${assets.inlineCss}</style>`

  const scriptTags = hydrationBootstrap(assets.scripts)

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
${themeColor === null ? '' : `<meta name="theme-color" content="${themeColor}" />`}
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<title>${rendered.title}</title>
${rendered.preload}
${rendered.head}
${styleTags}
${rendered.themeCss === '' ? '' : `<style id="selld-theme">${rendered.themeCss}</style>`}
</head>
<body>
<div id="root">${rendered.html}</div>
<script type="application/json" id="selld-state">${rendered.state}</script>
${scriptTags}
</body>
</html>`
}

/**
 * Load the hydration bundle only once it cannot hurt the LCP.
 *
 * `<script type="module">` is deferred in *execution*, which is why it does not
 * block first paint — but the browser still starts *downloading* it immediately,
 * at a priority that competes with images. Measured on the home page: the React
 * vendor chunk is ~193KB, which is about a second of a 1.6 Mbps link, and it was
 * being fetched in parallel with the LCP image. LCP sat at 2.7s against a 2.0s
 * budget with the network otherwise almost idle.
 *
 * This surface can afford to wait, because nothing on it is broken before
 * hydration: navigation is real links, search is a real GET form, and the price,
 * stock state and sold-out styling are all in the server-rendered HTML. Hydration
 * only adds the variant picker and the image gallery.
 *
 * So the script is injected after `load`, during idle time — or immediately on the
 * first interaction, whichever comes first. A buyer who taps a size straight away
 * does not wait for an idle callback that may never come.
 *
 * The injected scripts also carry `fetchpriority="low"`. A dynamically created
 * script element defaults to High, so without it the hydration bundle competes
 * with the LCP image for bandwidth even though it was requested later — and on a
 * product page, where the LCP image is the largest single asset, that is exactly
 * the transfer that must not be crowded out.
 *
 * The inline bootstrap is ~450 bytes and deliberately ES5: it runs before any of
 * our own code, on whatever browser a buyer happens to have.
 */
function hydrationBootstrap(scripts: string[]): string {
  if (scripts.length === 0) return ''
  const list = JSON.stringify(scripts)

  return `<script>(function(){var s=${list},d=0;function go(){if(d)return;d=1;for(var i=0;i<s.length;i++){var e=document.createElement('script');e.type='module';e.src=s[i];e.fetchPriority='low';document.head.appendChild(e)}}function idle(){if(window.requestIdleCallback){requestIdleCallback(go,{timeout:2500})}else{setTimeout(go,200)}}if(document.readyState==='complete'){idle()}else{addEventListener('load',idle)}var t=['pointerdown','touchstart','keydown'];for(var j=0;j<t.length;j++){addEventListener(t[j],go,{once:true,passive:true})}})()</script>`
}

/** Branding for either page shape. Mirrors `storeOf` in the renderer. */
function pageStore(data: StorefrontPage): HomePayload['store'] | null {
  if (data.route === 'home' || data.route === 'product') return data.payload.store
  return data.store ?? null
}

// ---------------------------------------------------------------------------
// Static assets, robots, sitemap
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
  if (pathname === '/' || pathname.endsWith('/')) return false

  // Normalise before joining. Without this, `/assets/../../.env` escapes the
  // build directory and serves whatever it lands on.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const file = join(ROOT, 'dist/client', safe)
  if (!file.startsWith(join(ROOT, 'dist/client'))) return false
  if (!existsSync(file)) return false

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'Content-Type': type,
    // Hashed filenames are immutable; anything else gets a short TTL.
    'Cache-Control': safe.includes('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600',
  })
  createReadStream(file).pipe(response)
  return true
}

function isViteAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/@') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname.startsWith('/favicon') ||
    /\.(?:js|ts|tsx|css|svg|png|jpe?g|webp|avif|ico|woff2?|map)$/.test(pathname)
  )
}

function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    // Search result pages are noindex in the head too; disallowing the crawl
    // saves the budget rather than spending it to read a noindex.
    'Disallow: /?q=',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

async function buildSitemap(
  supabase: SupabaseConfig,
  input: { slug: string | null; domain: string | null; origin: string },
): Promise<string | null> {
  const data = await rpc<{
    slug: string
    products: { slug: string; updatedAt: string }[]
    categories: string[]
  } | null>(supabase, 'storefront_sitemap', { p_slug: input.slug, p_domain: input.domain })

  if (data === null) return null

  const urls = [
    `<url><loc>${input.origin}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...data.categories
      .filter((slug) => typeof slug === 'string')
      .map(
        (slug) =>
          `<url><loc>${input.origin}/?category=${encodeURIComponent(slug)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`,
      ),
    ...data.products.map(
      (product) =>
        `<url><loc>${input.origin}/p/${encodeURIComponent(product.slug)}</loc><lastmod>${product.updatedAt.slice(0, 10)}</lastmod><priority>0.8</priority></url>`,
    ),
  ]

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
}

function sendNotFoundXml(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'application/xml; charset=utf-8' })
  response.end('<?xml version="1.0" encoding="UTF-8"?><urlset />')
}

function serveDashboard(
  request: IncomingMessage,
  response: ServerResponse,
  context: { middlewares: Middlewares },
): Promise<void> | void {
  if (context.middlewares !== null) {
    return new Promise<void>((resolveRequest) => {
      context.middlewares!(request, response, () => {
        response.writeHead(404).end()
        resolveRequest()
      })
      response.on('close', () => resolveRequest())
    })
  }

  const shell = join(ROOT, 'dist/client/index.html')
  if (!existsSync(shell)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Dashboard build missing.')
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  response.end(readFileSync(shell))
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Compress before sending.
 *
 * A server-rendered document with inlined CSS is ~40KB of text. Uncompressed,
 * that is a third of the 3G budget spent on bytes a compressor removes for free;
 * this single step is worth more to the LCP score than any component-level
 * optimisation in this phase.
 */
function compress(
  request: IncomingMessage,
  body: string,
): { payload: Buffer | string; encoding: string | null } {
  const accepted = (request.headers['accept-encoding'] ?? '').toString()
  if (/\bbr\b/.test(accepted)) return { payload: brotliCompressSync(body), encoding: 'br' }
  if (/\bgzip\b/.test(accepted)) return { payload: gzipSync(body), encoding: 'gzip' }
  return { payload: body, encoding: null }
}

function sendHtml(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  status: number,
): void {
  const { payload, encoding } = compress(request, body)
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...(encoding === null ? {} : { 'Content-Encoding': encoding }),
    Vary: 'Accept-Encoding',
    // The document is public and identical for every buyer, so a CDN can serve
    // it. `s-maxage` lets the edge cache it while `max-age=0` keeps the browser
    // revalidating, so a seller's price change is visible immediately on reload.
    'Cache-Control':
      status === 200
        ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
        : 'public, max-age=0, s-maxage=30',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
  response.end(payload)
}

function sendText(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  type: string,
): void {
  const { payload, encoding } = compress(request, body)
  response.writeHead(200, {
    'Content-Type': type,
    ...(encoding === null ? {} : { 'Content-Encoding': encoding }),
    Vary: 'Accept-Encoding',
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
  })
  response.end(payload)
}

/**
 * Only when this file *is* the process.
 *
 * Importing it — which a serverless entry point does — must not bind a port or
 * start a background loop. `pnpm start` and `pnpm dev:store` both invoke it
 * directly, so argv[1] is this file and the server comes up as before.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) void main()
