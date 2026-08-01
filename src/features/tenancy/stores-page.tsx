import { Check, ChevronDown, ExternalLink, Plus, Settings2, Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StorePanel } from '@/features/tenancy/store-panel'
import { createTenant } from '@/features/tenancy/tenancy-api'
import { useTenant } from '@/features/tenancy/use-tenant'
import { env } from '@/lib/env'
import type { Translate } from '@/lib/i18n'
import { errorMessage } from '@/lib/supabase/errors'
import {
  isReservedSlug,
  isValidSlug,
  slugify,
  slugifyWhileTyping,
  storeAddress,
} from '@/lib/tenant/resolve-tenant'
import { cn } from '@/lib/utils'

/**
 * Every store this seller belongs to, and the way to open another.
 *
 * This screen exists because the header switcher renders as plain text when
 * there is exactly one store — correct on its own terms, a dropdown with one
 * option is noise — but the consequence was that a seller with one store had no
 * route to a second one anywhere in the product. `CreateStorePage` only ever
 * appears for somebody who belongs to *none*. A seller opening a second brand
 * had to be told to sign up again with a different email.
 */
export function StoresPage() {
  const { t } = useTranslation()
  const { tenants, activeTenant, setActiveTenant, refetch } = useTenant()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One panel at a time. Two open QR codes on a 390px screen is a scroll, not a
  // comparison, and nothing here is worth comparing side by side.
  const [expanded, setExpanded] = useState<string | null>(null)

  const effectiveSlug = slugEdited ? slug : slugify(name)
  const slugProblem =
    effectiveSlug === ''
      ? null
      : !isValidSlug(effectiveSlug)
        ? t('tenant.slugInvalid')
        : isReservedSlug(effectiveSlug)
          ? t('tenant.slugReserved')
          : null

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (slugProblem !== null || effectiveSlug === '') return

    setBusy(true)
    try {
      await createTenant({ name, slug: effectiveSlug })
      await refetch()
      /*
       * Deliberately does *not* switch to the new store.
       *
       * `CreateStorePage` does switch, and is right to — somebody who owns no
       * store at all has nowhere else to be. Here the seller chose to be on a
       * management screen, and switching drops them into the five-step
       * onboarding wizard for the store they just made, several screens from
       * where they were. It appears in the list; they open it when they mean to.
       */
      setName('')
      setSlug('')
      setSlugEdited(false)
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="font-headline text-2xl font-bold tracking-tight">{t('tenant.storesTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('tenant.storesSubtitle')} · {t('tenant.storesCount', { count: tenants.length })}
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {tenants.map((tenant) => {
          const isActive = tenant.id === activeTenant?.id
          const address = storeAddress(tenant.slug, {
            rootDomain: env.rootDomain,
            mode: env.storeUrlMode,
          })
          const isOpen = expanded === tenant.id
          return (
            <li key={tenant.id}>
              <div
                className={cn(
                  'rounded-xl border',
                  isActive ? 'border-primary/40 bg-primary/5' : 'bg-card',
                )}
              >
              <div className="flex flex-wrap items-center gap-3 p-4">
                <span
                  className={cn(
                    'grid size-10 shrink-0 place-items-center rounded-lg',
                    isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Store className="size-5" aria-hidden="true" />
                </span>

                {/* `truncate` on the flex *container* clipped the badge and the
                    role rather than the long text beside them — at 390px the
                    store read "Rhea's Finds ✓ O…" and "rheas-finds.selld.ph ·
                    O…". Clip the one thing that is allowed to be long; let
                    everything else keep its width. */}
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 font-semibold">
                    <span className="truncate">{tenant.name}</span>
                    {isActive && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                        <Check className="size-3" aria-hidden="true" />
                        {t('tenant.storesCurrent')}
                      </span>
                    )}
                  </p>
                  <p className="flex min-w-0 gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{address}</span>
                    <span className="shrink-0">· {t(`tenant.role.${tenant.role}`)}</span>
                  </p>
                </div>

                {/* Its own line on a phone. Sharing one with the store name left
                    about 120px for the name, so "Rhea's Finds" rendered as "R…"
                    — the one word on the row a seller is actually looking for. */}
                <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                  <a
                    href={`https://${address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ExternalLink className="size-4" aria-hidden="true" />
                    {t('tenant.storesViewShop')}
                  </a>
                  {!isActive && (
                    <Button size="sm" onClick={() => { setActiveTenant(tenant.id) }}>
                      {t('tenant.storesOpen')}
                    </Button>
                  )}
                </div>

                {/* A disclosure rather than always-open: a seller with four
                    stores would otherwise scroll past four QR codes and four
                    week-long schedules to reach the fourth store's name. The
                    panel is only mounted while it is open, so the settings query
                    behind it costs nothing until asked for. */}
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`store-panel-${tenant.id}`}
                  onClick={() => { setExpanded(isOpen ? null : tenant.id) }}
                  className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:w-auto"
                >
                  <Settings2 className="size-4" aria-hidden="true" />
                  {t('tenant.storesManage')}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-4 transition-transform', isOpen && 'rotate-180')}
                  />
                </button>
              </div>

              {isOpen && (
                <div id={`store-panel-${tenant.id}`}>
                  <StorePanel tenant={tenant} address={address} />
                </div>
              )}
              </div>
            </li>
          )
        })}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" aria-hidden="true" />
            {t('tenant.storesNewTitle')}
          </CardTitle>
          <CardDescription>{t('tenant.storesNewBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-store-name">{t('tenant.nameLabel')}</Label>
              <Input
                id="new-store-name"
                required
                maxLength={120}
                placeholder={t('tenant.namePlaceholder')}
                value={name}
                onChange={(event) => { setName(event.target.value) }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-store-slug">{t('tenant.slugLabel')}</Label>
              <Input
                id="new-store-slug"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugEdited(true)
                  setSlug(slugifyWhileTyping(event.target.value))
                }}
                aria-invalid={slugProblem !== null}
              />
              {/* Same rule as the create-store screen: only ever show an address
                  that could resolve. */}
              <p className="text-xs text-muted-foreground">
                {effectiveSlug !== '' && slugProblem === null
                  ? storeAddress(effectiveSlug, {
                      rootDomain: env.rootDomain,
                      mode: env.storeUrlMode,
                    })
                  : t('tenant.slugHint')}
              </p>
              {slugProblem !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {slugProblem}
                </p>
              )}
            </div>

            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={busy || slugProblem !== null || effectiveSlug === ''}
              className="w-full sm:w-auto"
            >
              {busy ? t('tenant.storesCreating') : t('tenant.storesCreate')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/** Same shape as create-store-page: a PostgREST error is a plain object. */
function describe(cause: unknown, t: Translate): string {
  const message = errorMessage(cause).toLowerCase()
  if (message === '') return t('errors.unexpected')
  if (message.includes('duplicate') || message.includes('already')) return t('tenant.slugTaken')
  if (message.includes('reserved')) return t('tenant.slugReserved')
  if (message.includes('invalid store address')) return t('tenant.slugInvalid')
  return errorMessage(cause)
}
