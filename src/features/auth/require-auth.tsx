import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { SignInPage } from '@/features/auth/sign-in-page'
import { useSession } from '@/features/auth/use-session'
import { OnboardingWizard } from '@/features/onboarding/onboarding-wizard'
import { CreateStorePage } from '@/features/tenancy/create-store-page'
import { useTenant } from '@/features/tenancy/use-tenant'
import { fetchSettings } from '@/lib/settings'

/**
 * Gate for the whole dashboard.
 *
 * Four states, in this order, and the order matters:
 *
 *  1. **loading** — render a neutral shell. Rendering the sign-in page here would
 *     flash it in front of an already-authenticated seller on every reload.
 *  2. **anonymous** — sign in.
 *  3. **authenticated, no tenant** — create a store.
 *  4. **tenant exists, onboarding unfinished** — the wizard, resumed at the step
 *     the seller stopped on.
 *
 * This is convenience, not security. Every query behind it is independently
 * protected by RLS, so bypassing this component in the client yields dashboard
 * chrome that returns zero rows.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { status } = useSession()
  const { tenants, activeTenant, isLoading: tenantsLoading, error } = useTenant()

  const settings = useQuery({
    queryKey: ['tenant-settings', activeTenant?.id],
    queryFn: () => fetchSettings(activeTenant?.id ?? ''),
    enabled: activeTenant !== null,
  })

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

  if (settings.isLoading) return <Splash label={t('common.loading')} />

  // Only gate on a *known* incomplete state. If settings failed to load we let
  // the seller into the dashboard rather than trapping her in a wizard we cannot
  // read the progress of.
  if (settings.isSuccess && settings.data['onboarding.completed_at'] === null) {
    return <OnboardingWizard />
  }

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
