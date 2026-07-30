import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'

import { SessionContext, type SessionState } from '@/features/auth/session-context'
import { hasSupabaseConfig } from '@/lib/env'
import { getSupabase } from '@/lib/supabase/client'

/**
 * Supabase session, exposed to the tree.
 *
 * Two details that matter:
 *
 * 1. The initial state is `loading`, not `anonymous`. Supabase restores a session
 *    from storage asynchronously, so treating "no session yet" as signed out
 *    bounces an already-authenticated seller to the login screen on every reload.
 *
 * 2. `onAuthStateChange` is subscribed *before* the initial `getSession()` promise
 *    resolves, so a token refresh landing during startup is not missed.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(() => ({
    status: hasSupabaseConfig() ? 'loading' : 'unconfigured',
    session: null,
    user: null,
  }))

  useEffect(() => {
    if (!hasSupabaseConfig()) return

    const supabase = getSupabase()
    let active = true

    const apply = (session: Session | null) => {
      if (!active) return
      setState({
        status: session ? 'authenticated' : 'anonymous',
        session,
        user: session?.user ?? null,
      })
    }

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      apply(session)
    })

    void supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        apply(session)
      })
      .catch(() => {
        apply(null)
      })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}
