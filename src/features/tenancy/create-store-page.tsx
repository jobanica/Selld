import { Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signOut } from '@/features/auth/auth-api'
import { createTenant } from '@/features/tenancy/tenancy-api'
import { useTenant } from '@/features/tenancy/use-tenant'
import type { Translate } from '@/lib/i18n'
import { env } from '@/lib/env'
import { errorMessage } from '@/lib/supabase/errors'
import {
  isReservedSlug,
  isValidSlug,
  slugify,
  slugifyWhileTyping,
} from '@/lib/tenant/resolve-tenant'

/**
 * Shown when an authenticated user belongs to no tenant yet.
 *
 * Phase 2 replaces this with the full 5-step onboarding wizard. It exists now
 * because without it a freshly signed-up seller lands on a dashboard with no
 * tenant and nothing works — the minimum to make phase 1 coherent end to end.
 */
export function CreateStorePage() {
  const { t } = useTranslation()
  const { refetch, setActiveTenant } = useTenant()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Suggest a slug from the name until the seller edits it themselves.
  const effectiveSlug = slugEdited ? slug : slugify(name)

  const slugProblem =
    effectiveSlug === ''
      ? null
      : !isValidSlug(effectiveSlug)
        ? t('tenant.slugInvalid')
        : isReservedSlug(effectiveSlug)
          ? t('tenant.slugReserved')
          : null

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (slugProblem) return

    setBusy(true)
    try {
      const tenant = await createTenant({ name, slug: effectiveSlug })
      setActiveTenant(tenant.id)
      await refetch()
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-start justify-center bg-muted/30 px-4 py-8 sm:items-center">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Store className="size-5" aria-hidden="true" />
          </span>
          <CardTitle>{t('tenant.noStoreTitle')}</CardTitle>
          <CardDescription>{t('tenant.noStoreBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="store-name">{t('tenant.nameLabel')}</Label>
              <Input
                id="store-name"
                required
                maxLength={120}
                autoComplete="organization"
                placeholder={t('tenant.namePlaceholder')}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="store-slug">{t('tenant.slugLabel')}</Label>
              <Input
                id="store-slug"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={effectiveSlug}
                inputMode="url"
                onChange={(event) => {
                  setSlugEdited(true)
                  setSlug(slugifyWhileTyping(event.target.value))
                }}
                aria-invalid={slugProblem !== null}
                aria-describedby="store-slug-hint"
              />
              {/* Only ever show an address that could actually resolve. Echoing
                  the raw value rendered `phase .selld.vercel.app` — a hostname
                  with a space in it, presented to the seller as their shop. */}
              <p id="store-slug-hint" className="text-xs text-muted-foreground">
                {effectiveSlug !== '' && slugProblem === null
                  ? `${effectiveSlug}.${env.rootDomain}`
                  : t('tenant.slugHint')}
              </p>
              {slugProblem && (
                <p role="alert" className="text-sm text-destructive">
                  {slugProblem}
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={busy || slugProblem !== null || effectiveSlug === ''}
              className="w-full"
            >
              {busy ? t('tenant.creating') : t('tenant.createStore')}
            </Button>

            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => void signOut()}
              disabled={busy}
            >
              {t('auth.signOut')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Note what this does NOT do: `cause instanceof Error`.
 *
 * `createTenant` throws whatever postgrest-js put in `error`, and on the
 * ordinary destructuring path that is a **plain object** — the PostgrestError
 * class is only constructed under `.throwOnError()`. Gating on `instanceof`
 * therefore sent every real database failure to "something went wrong", so a
 * seller whose chosen address was already taken was told nothing useful and had
 * no reason to change it. Same trap as `describeStockError` and
 * `describeShippingError`; `errorMessage()` is the fix.
 */
function describe(cause: unknown, t: Translate): string {
  const message = errorMessage(cause).toLowerCase()
  if (message === '') return t('errors.unexpected')
  // 23505 unique_violation — the slug was taken between our check and the insert.
  if (message.includes('duplicate') || message.includes('already')) {
    return t('tenant.slugTaken')
  }
  if (message.includes('reserved')) return t('tenant.slugReserved')
  if (message.includes('invalid store address')) return t('tenant.slugInvalid')
  return errorMessage(cause)
}
