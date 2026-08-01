import { useQuery } from '@tanstack/react-query'
import { SelldMark } from '@/components/selld-logo'
import { Check } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LocaleSwitcher } from '@/components/locale-switcher'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EMPTY_PH_ADDRESS, type PhAddressValue } from '@/features/address/ph-address'
import { useTenant } from '@/features/tenancy/use-tenant'
import { fetchSettings, writeSettings } from '@/lib/settings'
import { env } from '@/lib/env'
import { storeAddress } from '@/lib/tenant/resolve-tenant'
import { cn } from '@/lib/utils'

import { fetchDefaultLocation, fetchTheme } from './onboarding-api'
import { StepBranding } from './steps/step-branding'
import { StepIdentity } from './steps/step-identity'
import { StepOrigin } from './steps/step-origin'
import { StepPayments } from './steps/step-payments'
import { StepPresets } from './steps/step-presets'

export const TOTAL_STEPS = 5

/**
 * The 5-step store setup wizard.
 *
 * Each step saves the moment it is completed, and the current step number lives
 * in `tenant_settings['onboarding.step']`. A seller who drops off — a call comes
 * in, the jeepney arrives, the data runs out — resumes exactly where she stopped
 * rather than starting again. That is the difference between a 3-minute setup and
 * an abandoned signup.
 *
 * Step 1 already happened by the time this renders: the tenant must exist before
 * anything else can be written against it, so `create_tenant` runs first and this
 * wizard *edits* the name and slug rather than creating them.
 */
export function OnboardingWizard() {
  const { t } = useTranslation()
  const { activeTenant, refetch } = useTenant()
  const tenantId = activeTenant?.id ?? null

  const settings = useQuery({
    queryKey: ['tenant-settings', tenantId],
    queryFn: () => fetchSettings(tenantId ?? ''),
    enabled: tenantId !== null,
  })

  const theme = useQuery({
    queryKey: ['tenant-theme', tenantId],
    queryFn: () => fetchTheme(tenantId ?? ''),
    enabled: tenantId !== null,
  })

  const location = useQuery({
    queryKey: ['tenant-default-location', tenantId],
    queryFn: () => fetchDefaultLocation(tenantId ?? ''),
    enabled: tenantId !== null,
  })

  // Resume where the seller stopped, but never ahead of what is loaded.
  const [step, setStep] = useState<number | null>(null)
  const resolvedStep = step ?? settings.data?.['onboarding.step'] ?? 1

  const advance = useCallback(
    async (next: number) => {
      setStep(next)
      if (tenantId) {
        await writeSettings(tenantId, { 'onboarding.step': Math.min(next, TOTAL_STEPS) })
        await settings.refetch()
      }
    },
    [tenantId, settings],
  )

  const finish = useCallback(async () => {
    if (!tenantId) return
    await writeSettings(tenantId, {
      'onboarding.completed_at': new Date().toISOString(),
      'onboarding.step': TOTAL_STEPS,
    })
    await Promise.all([settings.refetch(), refetch()])
  }, [tenantId, settings, refetch])

  if (!activeTenant || settings.isLoading || theme.isLoading || location.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center" role="status" aria-busy="true">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    )
  }

  const storeUrl = storeAddress(activeTenant.slug, {
    rootDomain: env.rootDomain,
    mode: env.storeUrlMode,
  })
  const copy = STEP_COPY[resolvedStep - 1] ?? STEP_COPY[0]

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="flex h-14 shrink-0 items-center justify-between px-4">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <SelldMark className="size-7 shrink-0" />
          {t('app.name')}
        </span>
        <LocaleSwitcher />
      </header>

      <main className="flex flex-1 justify-center px-4 pb-10">
        <div className="w-full max-w-lg">
          <StepIndicator current={resolvedStep} total={TOTAL_STEPS} />

          <Card>
            <CardHeader>
              <CardDescription>
                {t('onboarding.stepOf', { current: resolvedStep, total: TOTAL_STEPS })}
              </CardDescription>
              <CardTitle>{t(copy.title)}</CardTitle>
              <CardDescription>{t(copy.body)}</CardDescription>
            </CardHeader>
            <CardContent>
              {resolvedStep === 1 && (
                <StepIdentity
                  tenantId={activeTenant.id}
                  initialName={activeTenant.name}
                  slug={activeTenant.slug}
                  onDone={() => void advance(2)}
                />
              )}
              {resolvedStep === 2 && (
                <StepBranding
                  tenantId={activeTenant.id}
                  initialLogoPath={activeTenant.logoPath}
                  initialColor={activeTenant.brandColor}
                  initialPreset={theme.data?.preset ?? 'clean'}
                  onBack={() => void advance(1)}
                  onDone={() => void advance(3)}
                />
              )}
              {resolvedStep === 3 && (
                <StepPresets
                  tenantId={activeTenant.id}
                  initial={settings.data?.['catalog.presets'] ?? []}
                  onBack={() => void advance(2)}
                  onDone={() => void advance(4)}
                />
              )}
              {resolvedStep === 4 && (
                <StepOrigin
                  tenantId={activeTenant.id}
                  initialName={location.data?.name ?? ''}
                  initialAddress={location.data?.address ?? (EMPTY_PH_ADDRESS as PhAddressValue)}
                  initialContactName={location.data?.contactName ?? ''}
                  initialContactPhone={location.data?.contactPhone ?? ''}
                  onBack={() => void advance(3)}
                  onDone={() => void advance(5)}
                />
              )}
              {resolvedStep === 5 && (
                <StepPayments
                  tenantId={activeTenant.id}
                  initialCodEnabled={settings.data?.['payments.cod_enabled'] ?? true}
                  initialCodFee={settings.data?.['payments.cod_fee_centavos'] ?? 0}
                  storeUrl={storeUrl}
                  onBack={() => void advance(4)}
                  onDone={() => void finish()}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

/**
 * `as const` so the key strings stay literal types — i18next only type-checks
 * `t()` against literal keys, and a widened `string` silently loses that.
 */
const STEP_COPY = [
  { title: 'onboarding.step1Title', body: 'onboarding.step1Body' },
  { title: 'onboarding.step2Title', body: 'onboarding.step2Body' },
  { title: 'onboarding.step3Title', body: 'onboarding.step3Body' },
  { title: 'onboarding.step4Title', body: 'onboarding.step4Body' },
  { title: 'onboarding.step5Title', body: 'onboarding.step5Body' },
] as const

/** Progress dots. Small, quiet, and legible at 390px. */
function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <ol className="mb-3 flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => {
        const step = index + 1
        const done = step < current
        const active = step === current
        return (
          <li
            key={step}
            className={cn(
              'flex h-1.5 flex-1 items-center rounded-full transition-colors',
              done || active ? 'bg-primary' : 'bg-border',
            )}
          >
            {done && <Check className="sr-only" />}
          </li>
        )
      })}
    </ol>
  )
}
