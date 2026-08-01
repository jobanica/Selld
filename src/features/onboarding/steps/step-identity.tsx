import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateTenantBranding } from '@/features/onboarding/onboarding-api'
import { useTenant } from '@/features/tenancy/use-tenant'
import { env } from '@/lib/env'
import { storeAddress } from '@/lib/tenant/resolve-tenant'
import type { Translate } from '@/lib/i18n'

import { StepNav } from './step-nav'

/**
 * Step 1 — store name.
 *
 * The slug is shown but not editable here. It was claimed when the tenant was
 * created and is already the store's public address; changing it silently would
 * break any link the seller has already shared. Renaming a store address is a
 * settings action with a redirect, not a wizard step.
 */
export function StepIdentity({
  tenantId,
  initialName,
  slug,
  onDone,
}: {
  tenantId: string
  initialName: string
  slug: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const { refetch } = useTenant()
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (name.trim() !== initialName) {
        await updateTenantBranding(tenantId, { name })
        await refetch()
      }
      onDone()
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-name">{t('tenant.nameLabel')}</Label>
        <Input
          id="onboarding-name"
          required
          maxLength={120}
          autoComplete="organization"
          placeholder={t('tenant.namePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-slug">{t('tenant.slugLabel')}</Label>
        <Input id="onboarding-slug" value={storeAddress(slug, { rootDomain: env.rootDomain, mode: env.storeUrlMode })} readOnly disabled />
        <p className="text-xs text-muted-foreground">{t('tenant.slugHint')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <StepNav busy={busy} disabled={name.trim() === ''} />
    </form>
  )
}

function describe(cause: unknown, t: Translate): string {
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
