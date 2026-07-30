import { Banknote, CreditCard } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Translate } from '@/lib/i18n'
import { formatPHP, parsePesos, toPesoInputValue, type Centavos } from '@/lib/money'
import { writeSettings } from '@/lib/settings'
import { cn } from '@/lib/utils'

import { StepNav } from './step-nav'

/**
 * Step 5 — how buyers pay.
 *
 * COD is on by default and cannot be switched off while it is the only method
 * available, because a storefront with no payment method is a storefront that
 * cannot take an order. Online payment stays disabled until Xendit is connected in
 * phase 8 — showing it as an inert toggle would promise something that silently
 * fails at checkout.
 */
export function StepPayments({
  tenantId,
  initialCodEnabled,
  initialCodFee,
  storeUrl,
  onBack,
  onDone,
}: {
  tenantId: string
  initialCodEnabled: boolean
  initialCodFee: Centavos | number
  storeUrl: string
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [codEnabled, setCodEnabled] = useState(initialCodEnabled)
  const [codFee, setCodFee] = useState(toPesoInputValue(initialCodFee as Centavos))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedFee = parsePesos(codFee === '' ? '0' : codFee)
  const feeValid = parsedFee !== null && parsedFee >= 0

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (!codEnabled) {
      // Online payments arrive in phase 8, so COD is currently the only way to
      // take money. Turning it off would leave the store unable to sell.
      setError(t('onboarding.needOnePayment'))
      return
    }
    if (!feeValid) {
      setError(t('onboarding.codFeeHint'))
      return
    }

    setBusy(true)
    try {
      await writeSettings(tenantId, {
        'payments.cod_enabled': codEnabled,
        'payments.cod_fee_centavos': parsedFee,
        'payments.online_enabled': false,
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
      <label
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
          codEnabled ? 'border-primary bg-primary/5' : 'border-input',
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
          checked={codEnabled}
          onChange={(event) => setCodEnabled(event.target.checked)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Banknote className="size-4" aria-hidden="true" />
            {t('onboarding.codLabel')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('onboarding.codHint')}
          </span>
        </span>
      </label>

      {codEnabled && (
        <div className="flex flex-col gap-1.5 pl-1">
          <Label htmlFor="cod-fee">{t('onboarding.codFeeLabel')}</Label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
            >
              ₱
            </span>
            <Input
              id="cod-fee"
              inputMode="decimal"
              className="pl-7"
              value={codFee}
              onChange={(event) => setCodFee(event.target.value)}
              aria-invalid={!feeValid}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('onboarding.codFeeHint')}
            {feeValid && parsedFee > 0 && ` — ${formatPHP(parsedFee)}`}
          </p>
        </div>
      )}

      {/* Deliberately inert until phase 8 connects Xendit. */}
      <div className="flex items-start gap-3 rounded-md border border-dashed p-3 opacity-70">
        <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('onboarding.onlineLabel')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('onboarding.onlineComingSoon')}
          </span>
        </span>
      </div>

      <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
        {t('onboarding.doneBody')}{' '}
        <span className="font-medium text-foreground">{storeUrl}</span>
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <StepNav onBack={onBack} busy={busy} submitLabel={t('onboarding.finish')} />
    </form>
  )
}

function describe(cause: unknown, t: Translate): string {
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
