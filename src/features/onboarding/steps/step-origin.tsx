import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isAddressComplete, type PhAddressValue } from '@/features/address/ph-address'
import { PhAddressPicker } from '@/features/address/ph-address-picker'
import { saveDefaultLocation } from '@/features/onboarding/onboarding-api'
import type { Translate } from '@/lib/i18n'
import { normalizePhPhone, parsePhPhone } from '@/lib/phone/ph-phone'

import { StepNav } from './step-nav'

/**
 * Step 4 — shipping origin.
 *
 * This is the first place PSGC data is used in anger. The address must reach
 * barangay level because that is what couriers route and price on, and it becomes
 * the pickup address for bulk booking in phase 10.
 */
export function StepOrigin({
  tenantId,
  initialName,
  initialAddress,
  initialContactName,
  initialContactPhone,
  onBack,
  onDone,
}: {
  tenantId: string
  initialName: string
  initialAddress: PhAddressValue
  initialContactName: string
  initialContactPhone: string
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName || 'Home')
  const [address, setAddress] = useState<PhAddressValue>(initialAddress)
  const [contactName, setContactName] = useState(initialContactName)
  const [contactPhone, setContactPhone] = useState(
    initialContactPhone ? (parsePhPhone(initialContactPhone)?.national ?? '') : '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const complete = isAddressComplete(address)
  const phoneValid = contactPhone.trim() === '' || parsePhPhone(contactPhone)?.kind === 'mobile'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (!complete) {
      setError(t('onboarding.addressIncomplete'))
      return
    }
    if (!phoneValid) {
      setError(t('auth.invalidPhone'))
      return
    }

    setBusy(true)
    try {
      await saveDefaultLocation(tenantId, {
        name,
        address,
        contactName,
        // Normalised to E.164 here so the column constraint never sees a local format.
        contactPhone: contactPhone.trim() === '' ? null : normalizePhPhone(contactPhone),
      })
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
        <Label htmlFor="origin-name">{t('onboarding.locationNameLabel')}</Label>
        <Input
          id="origin-name"
          required
          maxLength={120}
          placeholder={t('onboarding.locationNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <PhAddressPicker idPrefix="origin" value={address} onChange={setAddress} disabled={busy} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="origin-contact-name">{t('onboarding.contactNameLabel')}</Label>
        <Input
          id="origin-contact-name"
          autoComplete="name"
          value={contactName}
          onChange={(event) => setContactName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="origin-contact-phone">{t('onboarding.contactPhoneLabel')}</Label>
        <Input
          id="origin-contact-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={t('auth.mobilePlaceholder')}
          value={contactPhone}
          onChange={(event) => setContactPhone(event.target.value)}
          aria-invalid={!phoneValid}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <StepNav onBack={onBack} busy={busy} disabled={!complete || !phoneValid} />
    </form>
  )
}

function describe(cause: unknown, t: Translate): string {
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
