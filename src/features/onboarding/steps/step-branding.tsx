import { ImagePlus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  LogoValidationError,
  publicAssetUrl,
  updateTenantBranding,
  updateTheme,
  uploadTenantLogo,
  type ThemePreset,
} from '@/features/onboarding/onboarding-api'
import { useTenant } from '@/features/tenancy/use-tenant'
import type { Translate } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import { StepNav } from './step-nav'

/**
 * A small, opinionated palette rather than a colour wheel.
 *
 * Sellers are not designers, and an unconstrained picker reliably produces a
 * storefront in neon yellow on white. Every swatch here has been chosen to pass
 * contrast against white text, which is what the storefront renders on it.
 */
const BRAND_COLORS = [
  { value: '#12604f', name: 'Jade' },
  { value: '#0f5b8a', name: 'Ocean' },
  { value: '#7c3aed', name: 'Violet' },
  { value: '#be123c', name: 'Rose' },
  { value: '#c2410c', name: 'Terracotta' },
  { value: '#a16207', name: 'Gold' },
  { value: '#166534', name: 'Forest' },
  { value: '#1f2937', name: 'Charcoal' },
] as const

const PRESETS: { value: ThemePreset; labelKey: string }[] = [
  { value: 'clean', labelKey: 'Clean' },
  { value: 'bold', labelKey: 'Bold' },
  { value: 'warm', labelKey: 'Warm' },
  { value: 'mono', labelKey: 'Mono' },
]

/** Step 2 — logo, brand colour, storefront style. */
export function StepBranding({
  tenantId,
  initialLogoPath,
  initialColor,
  initialPreset,
  onBack,
  onDone,
}: {
  tenantId: string
  initialLogoPath: string | null
  initialColor: string | null
  initialPreset: ThemePreset
  onBack: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const { refetch } = useTenant()
  const fileInput = useRef<HTMLInputElement>(null)

  const [logoPath, setLogoPath] = useState(initialLogoPath)
  const [localPreview, setLocalPreview] = useState<string | null>(null)
  const [color, setColor] = useState(initialColor ?? BRAND_COLORS[0].value)
  const [preset, setPreset] = useState<ThemePreset>(initialPreset)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const previewUrl = localPreview ?? publicAssetUrl(logoPath)

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    setUploading(true)

    // Show the local file immediately; the upload is the slow part on mobile data
    // and a seller staring at nothing assumes it failed.
    const objectUrl = URL.createObjectURL(file)
    setLocalPreview(objectUrl)

    try {
      const path = await uploadTenantLogo(tenantId, file)
      setLogoPath(path)
    } catch (cause) {
      setLocalPreview(null)
      URL.revokeObjectURL(objectUrl)
      setError(describe(cause, t))
    } finally {
      setUploading(false)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await updateTenantBranding(tenantId, { logoPath, brandColor: color })
      await updateTheme(tenantId, { preset, colors: { primary: color } })
      await refetch()
      onDone()
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label>{t('onboarding.logoLabel')}</Label>
        <div className="flex items-center gap-3">
          <div
            className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted"
            style={previewUrl ? undefined : { backgroundColor: `${color}1a` }}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <ImagePlus className="size-6 text-muted-foreground" aria-hidden="true" />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading || busy}
                onClick={() => fileInput.current?.click()}
              >
                {uploading
                  ? t('onboarding.logoUploading')
                  : previewUrl
                    ? t('onboarding.logoReplace')
                    : t('onboarding.logoChoose')}
              </Button>
              {previewUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={uploading || busy}
                  onClick={() => {
                    setLogoPath(null)
                    setLocalPreview(null)
                  }}
                >
                  <X className="size-4" aria-hidden="true" />
                  {t('onboarding.logoRemove')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('onboarding.logoHint')}</p>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={handleFile}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium leading-none">
          {t('onboarding.colorLabel')}
        </legend>
        <div className="flex flex-wrap gap-2">
          {BRAND_COLORS.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              aria-label={swatch.name}
              aria-pressed={color === swatch.value}
              onClick={() => setColor(swatch.value)}
              style={{ backgroundColor: swatch.value }}
              className={cn(
                'size-11 rounded-full border-2 transition-transform',
                color === swatch.value
                  ? 'border-foreground scale-105'
                  : 'border-transparent hover:scale-105',
              )}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium leading-none">
          {t('onboarding.presetLabel')}
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={preset === option.value}
              onClick={() => setPreset(option.value)}
              className={cn(
                'min-h-11 rounded-md border px-3 text-sm font-medium transition-colors',
                preset === option.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-input hover:bg-accent',
              )}
            >
              {option.labelKey}
            </button>
          ))}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <StepNav onBack={onBack} busy={busy} disabled={uploading} />
    </form>
  )
}

function describe(cause: unknown, t: Translate): string {
  if (cause instanceof LogoValidationError) {
    return cause.reason === 'too_large'
      ? t('onboarding.logoTooLarge')
      : t('onboarding.logoWrongType')
  }
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
