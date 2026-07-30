/**
 * Client environment.
 *
 * Anything reachable from here is in the browser bundle and therefore PUBLIC.
 * Secrets belong in Edge Function secrets or server-side Vercel env vars, never
 * in a `VITE_` variable.
 *
 * Validation is deliberately lazy. Importing this module must never throw, so
 * the app shell still renders (and can show a useful message) when a developer
 * has not created `.env.local` yet. Callers that genuinely need Supabase ask for
 * it via {@link requireSupabaseConfig}.
 */

const raw = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  rootDomain: import.meta.env.VITE_APP_ROOT_DOMAIN,
  appEnv: import.meta.env.VITE_APP_ENV,
}

function present(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

export const env = {
  supabaseUrl: present(raw.supabaseUrl),
  supabaseAnonKey: present(raw.supabaseAnonKey),
  /** Storefronts live at `{slug}.<rootDomain>`. */
  rootDomain: present(raw.rootDomain) ?? 'selld.ph',
  appEnv: present(raw.appEnv) ?? (import.meta.env.PROD ? 'production' : 'development'),
  isProduction: import.meta.env.PROD,
}

export interface SupabaseConfig {
  url: string
  anonKey: string
}

/** True when Supabase credentials are configured. */
export function hasSupabaseConfig(): boolean {
  return env.supabaseUrl !== null && env.supabaseAnonKey !== null
}

export class MissingEnvError extends Error {
  constructor(names: string[]) {
    super(
      `Missing environment variable${names.length > 1 ? 's' : ''}: ${names.join(', ')}. ` +
        'Copy .env.example to .env.local and fill it in (run `pnpm db:start` to get local values).',
    )
    this.name = 'MissingEnvError'
  }
}

export function requireSupabaseConfig(): SupabaseConfig {
  const missing: string[] = []
  if (env.supabaseUrl === null) missing.push('VITE_SUPABASE_URL')
  if (env.supabaseAnonKey === null) missing.push('VITE_SUPABASE_ANON_KEY')
  if (missing.length > 0) throw new MissingEnvError(missing)

  return { url: env.supabaseUrl!, anonKey: env.supabaseAnonKey! }
}
