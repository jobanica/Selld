import type { Session, User } from '@supabase/supabase-js'
import { createContext } from 'react'

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unconfigured'

export interface SessionState {
  status: SessionStatus
  session: Session | null
  user: User | null
}

/**
 * Kept apart from both the provider component and the hooks so each of those
 * files exports one kind of thing — which is what keeps Fast Refresh working
 * during development.
 */
export const SessionContext = createContext<SessionState | null>(null)
