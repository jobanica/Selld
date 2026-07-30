/**
 * Server-side PostgREST access for the storefront renderer.
 *
 * Plain `fetch`, not `@supabase/supabase-js`. The client library exists to manage
 * auth sessions, realtime subscriptions and storage uploads — none of which a
 * server rendering an anonymous read-only page needs. Calling the REST endpoint
 * directly also keeps the library out of any bundle the buyer might receive.
 *
 * The anon key is used deliberately. Every function called here is granted to
 * `anon` and reads only the public `storefront_*` projections, so the renderer
 * has exactly the privileges a buyer's browser would have. Using the service-role
 * key would work and would be a standing invitation to accidentally select a
 * column no buyer should see.
 */

export interface SupabaseConfig {
  url: string
  anonKey: string
}

export class RpcError extends Error {
  readonly status: number
  constructor(name: string, status: number, body: string) {
    super(`RPC ${name} failed with ${status}: ${body.slice(0, 400)}`)
    this.name = 'RpcError'
    this.status = status
  }
}

export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  // Accept the VITE_-prefixed names too: they are what `.env.local` already
  // holds for the dashboard, and requiring a second copy under a different name
  // is a setup step people forget and then debug for an hour.
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY
  if (url === undefined || anonKey === undefined) return null
  if (url.trim() === '' || anonKey.trim() === '') return null
  return { url: url.trim().replace(/\/+$/, ''), anonKey: anonKey.trim() }
}

/**
 * Call a Postgres function through PostgREST.
 *
 * `timeoutMs` matters more than it looks: without it a hung database connection
 * holds the request open until the client gives up, and the buyer sees a blank
 * tab rather than a page. Better to fail fast and render the error path.
 */
export async function rpc<T>(
  config: SupabaseConfig,
  name: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)

  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    })

    const text = await response.text()
    if (!response.ok) throw new RpcError(name, response.status, text)
    // A function returning SQL NULL comes back as the four bytes "null".
    return (text === '' ? null : JSON.parse(text)) as T
  } finally {
    clearTimeout(timeout)
  }
}
