import type { User } from '@supabase/supabase-js'
import { useContext } from 'react'

import { SessionContext, type SessionState } from '@/features/auth/session-context'

export function useSession(): SessionState {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession() must be used inside a <SessionProvider>')
  }
  return context
}

/** The signed-in user, or throw. Use inside routes already behind a guard. */
export function useUser(): User {
  const { user } = useSession()
  if (!user) throw new Error('useUser() called without an authenticated session')
  return user
}
