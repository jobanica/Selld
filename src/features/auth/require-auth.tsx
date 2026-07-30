import { useTranslation } from 'react-i18next'

import { SignInPage } from '@/features/auth/sign-in-page'
import { useSession } from '@/features/auth/use-session'
import { CreateStorePage } from '@/features/tenancy/create-store-page'
import { useTenant } from '@/features/tenancy/use-tenant'

/**
 * Gate for the whole dashboard.
 *
 * Three states, in order, and the order matters:
 *
 *  1. **loading** — render a neutral shell. Rendering the sign-in page here would
 *     flash it in front of an already-authenticated seller on every reload.
 *  2. **anonymous** — sign in.
 *  3. **authenticated but no tenant** — create a store. Phase 2 turns this into
 *     the full onboarding wizard.
 *
 * This is convenience, not security. Every query behind it is independently
 * protected by RLS, so bypassing this component in the client gets an attacker a
 * dashboard chrome that returns zero rows.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { status } = useSession()
  const { tenants, activeTenant, isLoading: tenantsLoading, error } = useTenant()

  if (status === 'loading') return <Splash label={t('common.loading')} />

  if (status === 'unconfigured') {
    return (
      <Splash label={t('auth.unconfigured')}>
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          {t('auth.unconfigured')}
        </p>
      </Splash>
    )
  }

  if (status === 'anonymous') return <SignInPage />

  if (tenantsLoading) return <Splash label={t('common.loading')} />

  if (error) {
    return (
      <Splash label={t('errors.unexpected')}>
        <p className="max-w-sm text-center text-sm text-destructive">
          {error instanceof Error ? error.message : t('errors.unexpected')}
        </p>
      </Splash>
    )
  }

  if (tenants.length === 0 || !activeTenant) return <CreateStorePage />

  return <>{children}</>
}

function Splash({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div
      className="grid min-h-dvh place-items-center px-6"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex flex-col items-center gap-3">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        {children}
      </div>
    </div>
  )
}
