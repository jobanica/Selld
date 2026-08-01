/**
 * Resolve which surface a request is for, from the hostname alone.
 *
 * Selld serves two very different apps from one deployment:
 *   - the dashboard, at the apex domain (`selld.ph`, `app.selld.ph`, localhost)
 *   - a tenant storefront, at `{slug}.selld.ph` or a custom domain
 *
 * Phase 1 replaces the storefront branch with a real tenant lookup; the
 * hostname parsing is settled here so both phases share one implementation and
 * the local dev story (`rhea.localhost:5173`) works from day one.
 */

/** Hostnames on the root domain that are the dashboard, not a store slug. */
const RESERVED_SUBDOMAINS = new Set([
  'app',
  'www',
  'api',
  'admin',
  'dashboard',
  'staging',
  'preview',
  'cdn',
  'assets',
  'mail',
  'status',
  'docs',
  'help',
  'blog',
])

/**
 * Where a path-mounted storefront lives.
 *
 * NOT `/s/` — that is the short-link capability from phase 16, and a collision
 * there would make every broadcast link ambiguous with a store named after its
 * own slug.
 */
export const STOREFRONT_PATH_PREFIX = '/store'

/**
 * How this deployment gives stores an address.
 *
 * `subdomain` is the product's real shape — `rhea.selld.ph` — and needs a
 * wildcard DNS record. `path` exists for hosts that cannot issue one:
 * `*.vercel.app` will not, so a deployment there can only reach a store at
 * `selld.vercel.app/store/rhea`. Set by `VITE_STORE_URL_MODE`.
 */
export type StoreUrlMode = 'subdomain' | 'path'

/**
 * The address a seller shares, without a scheme.
 *
 * One function, because this string is shown on the create-store screen, in the
 * onboarding wizard and on the setup checklist, and three copies of it is three
 * chances for the seller to be handed a link that does not load.
 */
export function storeAddress(
  slug: string,
  { rootDomain, mode }: { rootDomain: string; mode: StoreUrlMode },
): string {
  return mode === 'path'
    ? `${rootDomain}${STOREFRONT_PATH_PREFIX}/${slug}`
    : `${slug}.${rootDomain}`
}

export type SurfaceTarget =
  | { kind: 'dashboard' }
  /** A storefront identified by its subdomain slug. */
  | { kind: 'storefront'; slug: string; basePath: string }
  /** A storefront on a custom domain — resolved against `tenant_domains`. */
  | { kind: 'custom-domain'; hostname: string; basePath: string }

export interface ResolveOptions {
  /** e.g. `selld.ph`. */
  rootDomain: string
  /**
   * Request path. Supplying it enables the `/store/{slug}` form, which exists
   * because a platform hostname that cannot issue wildcard subdomains — a
   * `*.vercel.app` deployment, an IP, a preview URL — has no other way to give
   * a store an address. A hostname that already names a store wins; the prefix
   * is only consulted when the host resolves to the dashboard.
   */
  pathname?: string
}

/**
 * Join a storefront's mount point to a root-relative path.
 *
 * Every link and form action inside the storefront goes through this. Under the
 * subdomain form `basePath` is empty and it is the identity function, which is
 * what keeps the two forms from drifting: there is no separate code path to
 * forget to update.
 */
export function storeHref(basePath: string, path: string): string {
  if (basePath === '') return path
  if (path === '/') return basePath
  return `${basePath}${path}`
}

/**
 * `rhea.selld.ph` -> storefront `rhea`
 * `selld.ph` / `app.selld.ph` -> dashboard
 * `selld.ph/store/rhea` -> storefront `rhea`, mounted at `/store/rhea`
 * `rhea.localhost` -> storefront `rhea` (local dev)
 * `shop.rheasfinds.com` -> custom domain
 */
export function resolveSurface(
  hostname: string,
  { rootDomain, pathname }: ResolveOptions,
): SurfaceTarget {
  const host = normalizeHostname(hostname)
  const root = normalizeHostname(rootDomain)

  const byHost = ((): SurfaceTarget => {
    // Bare localhost / IP access is always the dashboard.
    if (host === 'localhost' || isIpAddress(host)) return { kind: 'dashboard' }

    // `*.localhost` is the local storefront convention.
    if (host.endsWith('.localhost')) {
      const slug = host.slice(0, -'.localhost'.length)
      return subdomainToTarget(slug)
    }

    if (host === root) return { kind: 'dashboard' }

    if (host.endsWith(`.${root}`)) {
      const slug = host.slice(0, -(root.length + 1))
      return subdomainToTarget(slug)
    }

    // Anything else is a custom domain the tenant pointed at us.
    return { kind: 'custom-domain', hostname: host, basePath: '' }
  })()

  // A hostname that already names a store wins outright. `/store/x` under
  // `rhea.selld.ph` is a page inside Rhea's shop, not a second store — treating
  // it otherwise would let any store mount any other store inside itself.
  if (byHost.kind !== 'dashboard') return byHost

  const mounted = pathname === undefined ? null : storefrontPathSlug(pathname)
  if (mounted === null) return byHost
  return { kind: 'storefront', slug: mounted, basePath: `${STOREFRONT_PATH_PREFIX}/${mounted}` }
}

/** `/store/rhea/p/soap` -> `rhea`; anything that is not a valid store -> null. */
function storefrontPathSlug(pathname: string): string | null {
  if (!pathname.startsWith(`${STOREFRONT_PATH_PREFIX}/`)) return null
  const rest = pathname.slice(STOREFRONT_PATH_PREFIX.length + 1)
  const slug = (rest.split('/')[0] ?? '').toLowerCase()
  // Same gate as a subdomain, so the two forms cannot disagree about what a
  // store may be called — including the reserved list.
  if (!isValidSlug(slug) || isReservedSlug(slug)) return null
  return slug
}

function subdomainToTarget(subdomain: string): SurfaceTarget {
  // Nested subdomains (`a.b.selld.ph`) are not store slugs.
  if (subdomain === '' || subdomain.includes('.')) return { kind: 'dashboard' }
  if (RESERVED_SUBDOMAINS.has(subdomain)) return { kind: 'dashboard' }
  if (!isValidSlug(subdomain)) return { kind: 'dashboard' }
  return { kind: 'storefront', slug: subdomain, basePath: '' }
}

function normalizeHostname(hostname: string): string {
  // Strip the port and lowercase; IPv6 brackets are left intact for the IP check.
  return hostname.trim().toLowerCase().replace(/:\d+$/, '')
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
}

/**
 * Store slugs: lowercase alphanumeric plus internal hyphens, 3–63 characters.
 * Matches DNS label rules, since every slug becomes a hostname.
 */
/**
 * `slugify()` for a field somebody is still typing into.
 *
 * A phone keyboard inserts a space when you tap a word suggestion, so the first
 * thing a seller does in the store-address field is produce one — and a raw
 * space fails `isValidSlug`, which turned "type your store address" into an
 * error message before the seller had finished the word. Spaces become hyphens
 * here instead.
 *
 * It cannot just call `slugify()`, which strips trailing hyphens: that makes a
 * hyphen impossible to type, because it is removed on the keystroke that enters
 * it. So a *single* trailing separator survives, and `slugify()` cleans it up if
 * the seller stops there.
 */
export function slugifyWhileTyping(value: string): string {
  const endsWithSeparator = /[-\s_]$/.test(value)
  const body = slugify(value)
  if (!endsWithSeparator || body === '') return body
  return `${body}-`.slice(0, 63)
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug) && slug.length >= 3
}

/** Slugs a tenant may not claim, because they collide with our own hostnames. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SUBDOMAINS.has(slug.toLowerCase())
}

/**
 * Suggest a slug from a store name: `"Rhea's Finds"` -> `"rheas-finds"`.
 *
 * Strips diacritics first so `"Niño's Kicks"` becomes `ninos-kicks` rather than
 * losing the character — Filipino store names routinely contain ñ, and dropping
 * it silently produces `nio-s-kicks`.
 *
 * Advisory only: `isValidSlug` still decides, and the database has the final say
 * via its own constraint.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Drop apostrophes rather than treating them as separators, so the very
    // common possessive store name reads correctly: "Rhea's Finds" must become
    // `rheas-finds`, not `rhea-s-finds`.
    .replace(/['\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}
