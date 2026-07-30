import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { requireSupabaseConfig } from '@/lib/env'

import type { Database } from './database.types'

export type SelldClient = SupabaseClient<Database>

let client: SelldClient | null = null

/**
 * The browser Supabase client, created on first use.
 *
 * Lazy so that importing anything in the tree does not require credentials —
 * see the note in `src/lib/env.ts`. Single instance because Supabase keeps auth
 * state and realtime subscriptions on it; creating a second one silently breaks
 * session refresh.
 */
export function getSupabase(): SelldClient {
  if (client) return client

  const { url, anonKey } = requireSupabaseConfig()
  client = createClient<Database>(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      headers: {
        // Shows up in Supabase logs, making it obvious which surface issued a query.
        'x-selld-client': 'web',
      },
    },
  })
  return client
}

/** Test seam — drops the memoised client so a suite can swap credentials. */
export function resetSupabaseClient(): void {
  client = null
}
