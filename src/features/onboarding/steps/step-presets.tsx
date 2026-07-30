import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CATEGORY_PRESETS, presetLabel } from '@/features/onboarding/category-presets'
import { useLocale } from '@/lib/i18n/use-locale'
import { writeSettings } from '@/lib/settings'
import type { Translate } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import { StepNav } from './step-nav'

/**
 * Step 3 — what do you sell.
 *
 * Multi-select, because sellers rarely sell one thing: the avatar sells skincare
 * *and* RTW, and forcing a single choice would make the categories we seed in
 * phase 3 wrong for most of them.
 *
 * Skippable. A seller who does not see herself in the list should not be blocked
 * from reaching a live storefront over a taxonomy question.
 */
export function StepPresets({
  tenantId,
  initial,
  onBack,
  onDone,
}: {
  tenantId: string
  initial: string[]
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const [selected, setSelected] = useState<string[]>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(key: string) {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    )
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await writeSettings(tenantId, { 'catalog.presets': selected })
      onDone()
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {CATEGORY_PRESETS.map((preset) => {
          const active = selected.includes(preset.key)
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(preset.key)}
              className={cn(
                'flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                active
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-input hover:bg-accent',
              )}
            >
              <span aria-hidden="true" className="text-base">
                {preset.emoji}
              </span>
              <span className="min-w-0 flex-1">{presetLabel(preset, locale)}</span>
            </button>
          )
        })}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <StepNav
        onBack={onBack}
        busy={busy}
        submitLabel={selected.length === 0 ? t('onboarding.skip') : t('onboarding.next')}
      />
    </form>
  )
}

function describe(cause: unknown, t: Translate): string {
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
