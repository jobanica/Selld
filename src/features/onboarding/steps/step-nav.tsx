import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

/**
 * Shared footer for every wizard step.
 *
 * `Continue` is full-width and last in the DOM so it sits under the thumb on a
 * phone; `Back` is a quiet ghost button because going back is the rarer action.
 */
export function StepNav({
  onBack,
  busy,
  disabled,
  submitLabel,
}: {
  onBack?: () => void
  busy?: boolean
  disabled?: boolean
  submitLabel?: string
}) {
  const { t } = useTranslation()

  return (
    <div className="mt-2 flex flex-col gap-2">
      <Button type="submit" className="w-full" disabled={busy || disabled}>
        {busy ? t('onboarding.saving') : (submitLabel ?? t('onboarding.next'))}
      </Button>
      {onBack && (
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          {t('onboarding.back')}
        </Button>
      )}
    </div>
  )
}
