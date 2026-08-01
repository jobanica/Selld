import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, CreditCard, Download, Plus, QrCode, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StoreQr } from '@/components/store-qr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchPaymentAccount } from '@/features/payments/payments-api'
import type { TenantSummary } from '@/features/tenancy/tenancy-api'
import type { Translate } from '@/lib/i18n'
import { ONLINE_METHODS, type OnlineMethod } from '@/lib/payments/online-methods'
import { downloadQrPng } from '@/lib/qr'
import { fetchSettings, writeSettings } from '@/lib/settings'
import {
  DEFAULT_STORE_HOURS,
  isValidTime,
  summariseWeek,
  formatTime12,
  type DayHours,
  type StoreHours,
  type WeekHours,
} from '@/lib/store-hours'
import { errorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils'

/**
 * Everything a seller manages *about a store* rather than inside it: the QR code
 * a buyer scans, the hours the shop takes orders, and which ways it can be paid.
 *
 * It lives on the stores list rather than in Settings because these three are the
 * things a seller reaches for when they are standing at a bazaar table — and
 * because they are per-store, which is exactly what this screen already is. The
 * one store the seller happens to have selected is not the one they are always
 * asking about.
 *
 * Writes go to `tenant_settings`, whose policy is `admin`. A staff member sees
 * the same panel read-only rather than a disabled-looking one that errors on
 * save: being told after the fact that you could not do the thing is worse than
 * not being offered it.
 */
export function StorePanel({ tenant, address }: { tenant: TenantSummary; address: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = tenant.role === 'owner' || tenant.role === 'admin'
  const url = `https://${address}`

  const settings = useQuery({
    queryKey: ['store-panel-settings', tenant.id],
    queryFn: () => fetchSettings(tenant.id),
  })

  return (
    // `min-w-0` on both columns, not decoration: a grid item's default
    // `min-width` is `auto`, so the column grows to its widest child rather than
    // letting it shrink — which is why the hours editor overflowed a 390px page
    // by 23px however narrow its own inputs were told to be.
    <div className="grid gap-5 border-t px-4 py-4 sm:grid-cols-2 sm:px-5">
      <div className="min-w-0">
        <QrBlock name={tenant.name} slug={tenant.slug} url={url} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PaymentBlock
          tenantId={tenant.id}
          settings={settings.data}
          canEdit={canEdit}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['store-panel-settings', tenant.id] })}
        />
        <HoursBlock
          tenantId={tenant.id}
          hours={settings.data?.['store.hours']}
          canEdit={canEdit}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['store-panel-settings', tenant.id] })}
        />
      </div>
      {!canEdit && (
        <p className="text-xs text-muted-foreground sm:col-span-2">{t('tenant.panelReadOnly')}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------
function QrBlock({ name, slug, url }: { name: string; slug: string; url: string }) {
  const { t } = useTranslation()

  return (
    <section className="flex flex-col gap-3">
      <BlockHeading icon={QrCode} title={t('tenant.qrTitle')} hint={t('tenant.qrHint')} />
      <div className="flex items-start gap-4">
        <StoreQr
          value={url}
          title={t('tenant.qrAlt', { store: name })}
          className="size-32 shrink-0 rounded-lg border bg-white p-1.5"
        />
        <div className="flex min-w-0 flex-col items-start gap-2">
          <p className="break-all text-xs text-muted-foreground">{url}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { downloadQrPng(url, `${slug}-qr.png`) }}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('tenant.qrDownload')}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------
const METHOD_LABELS: Record<OnlineMethod, string> = {
  gcash: 'GCash',
  maya: 'Maya',
  grabpay: 'GrabPay',
  qrph: 'QR Ph',
  card: 'Card',
}

function PaymentBlock({
  tenantId,
  settings,
  canEdit,
  onSaved,
}: {
  tenantId: string
  settings: { 'payments.cod_enabled': boolean; 'payments.online_enabled': boolean; 'payments.methods': OnlineMethod[] } | undefined
  canEdit: boolean
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  // Whether an account exists at all, so the note below is only shown to the
  // seller it applies to. The safe view carries no secret — that is what it is
  // for — and `payment_accounts` is admin-readable, so a staff member gets null
  // and simply sees no note.
  const account = useQuery({
    queryKey: ['store-panel-account', tenantId],
    queryFn: () => fetchPaymentAccount(tenantId),
    retry: false,
  })

  const save = useMutation({
    mutationFn: (values: Parameters<typeof writeSettings>[1]) => writeSettings(tenantId, values),
    onSuccess: () => { setError(null); onSaved() },
    onError: (cause) => { setError(describe(cause, t)) },
  })

  if (settings === undefined) return <BlockSkeleton />

  const cod = settings['payments.cod_enabled']
  const online = settings['payments.online_enabled']
  const methods = settings['payments.methods']

  return (
    <section className="flex flex-col gap-3">
      <BlockHeading icon={CreditCard} title={t('tenant.paymentTitle')} hint={t('tenant.paymentHint')} />

      <Toggle
        label={t('tenant.paymentCod')}
        description={t('tenant.paymentCodHint')}
        checked={cod}
        disabled={!canEdit || save.isPending}
        onChange={(value) => { save.mutate({ 'payments.cod_enabled': value }) }}
      />

      <Toggle
        label={t('tenant.paymentOnline')}
        description={t('tenant.paymentOnlineHint')}
        checked={online}
        disabled={!canEdit || save.isPending}
        onChange={(value) => { save.mutate({ 'payments.online_enabled': value }) }}
      />

      {/* Only where they can take effect. A wallet picker under a switch that is
          off is a control whose every state means the same thing. */}
      {online && (
        <div className="flex flex-wrap gap-2 pl-1">
          {ONLINE_METHODS.map((method) => {
            const on = methods.includes(method)
            return (
              <button
                key={method}
                type="button"
                disabled={!canEdit || save.isPending}
                aria-pressed={on}
                onClick={() => {
                  const next = on
                    ? methods.filter((item) => item !== method)
                    : ONLINE_METHODS.filter((item) => item === method || methods.includes(item))
                  save.mutate({ 'payments.methods': [...next] })
                }}
                className={cn(
                  'inline-flex h-11 items-center rounded-full border px-3.5 text-sm font-medium transition-colors disabled:opacity-60',
                  on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
                )}
              >
                {METHOD_LABELS[method]}
              </button>
            )
          })}
        </div>
      )}

      {/* Only when it is true. The switch being on is not enough — the shop
          shows nothing until an account can take the money — but saying so to a
          seller who already connected one reads as "it still is not working",
          which sends them back to a screen with nothing left to do on it. */}
      {online && account.data !== undefined && !(account.data?.isEnabled ?? false) && (
        <p className="text-xs text-muted-foreground">{t('tenant.paymentNeedsAccount')}</p>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------
const DAY_KEYS = [
  'tenant.dayMon',
  'tenant.dayTue',
  'tenant.dayWed',
  'tenant.dayThu',
  'tenant.dayFri',
  'tenant.daySat',
  'tenant.daySun',
] as const

function HoursBlock({
  tenantId,
  hours,
  canEdit,
  onSaved,
}: {
  tenantId: string
  hours: StoreHours | undefined
  canEdit: boolean
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)

  if (hours === undefined) return <BlockSkeleton />

  return (
    <section className="flex flex-col gap-3">
      <BlockHeading icon={Clock} title={t('tenant.hoursTitle')} hint={t('tenant.hoursHint')} />

      {editing ? (
        <HoursEditor
          tenantId={tenantId}
          initial={hours}
          onDone={() => { setEditing(false); onSaved() }}
          onCancel={() => { setEditing(false) }}
        />
      ) : (
        <div className="flex flex-col items-start gap-2">
          {!hours.enabled ? (
            <p className="text-sm text-muted-foreground">{t('tenant.hoursNotPublished')}</p>
          ) : (
            <>
              <dl className="w-full max-w-xs text-sm">
                {summariseWeek(hours.days).map((run) => (
                  <div key={run.from} className="flex items-baseline justify-between gap-4 py-0.5">
                    <dt className="text-muted-foreground">
                      {run.from === run.to
                        ? t(DAY_KEYS[run.from] ?? 'tenant.dayMon')
                        : `${t(DAY_KEYS[run.from] ?? 'tenant.dayMon')}–${t(DAY_KEYS[run.to] ?? 'tenant.daySun')}`}
                    </dt>
                    <dd className={run.hours === null ? 'text-muted-foreground' : 'font-medium'}>
                      {run.hours === null
                        ? t('tenant.dayClosed')
                        : `${formatTime12(run.hours.open)} – ${formatTime12(run.hours.close)}`}
                    </dd>
                  </div>
                ))}
              </dl>
              {hours.note !== '' && (
                <p className="text-xs text-muted-foreground">{hours.note}</p>
              )}
            </>
          )}
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(true) }}>
              {hours.enabled ? t('tenant.hoursEdit') : t('tenant.hoursSet')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

function HoursEditor({
  tenantId,
  initial,
  onDone,
  onCancel,
}: {
  tenantId: string
  initial: StoreHours
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  // A draft, so a half-typed `1` in an hour field never reaches the storefront.
  // Seeded from the default week rather than from seven blanks: a seller setting
  // hours for the first time adjusts Mon-Sat 9-6 far more often than they build
  // it from nothing.
  const [draft, setDraft] = useState<StoreHours>(
    initial.enabled ? initial : { ...DEFAULT_STORE_HOURS, enabled: true, note: initial.note },
  )
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (value: StoreHours) => writeSettings(tenantId, { 'store.hours': value }),
    onSuccess: onDone,
    onError: (cause) => { setError(describe(cause, t)) },
  })

  const setDay = (index: number, next: DayHours | null) => {
    const days = [...draft.days]
    days[index] = next
    setDraft({ ...draft, days: days as unknown as WeekHours })
  }

  // Every window has to be a real clock time before any of it is published.
  const invalid = draft.days.some(
    (day) => day !== null && (!isValidTime(day.open) || !isValidTime(day.close)),
  )

  return (
    <div className="flex flex-col gap-3">
      {/*
        One row per day, and it has to stay one row at 390px.

        A first pass gave each time field a fixed 7.5rem and a text button beside
        it, which overflowed the column: every day wrapped onto two lines and the
        week became fourteen. The fields now share the row with `min-w-0 flex-1`,
        and open/close is a 44px icon button with a spelled-out accessible name.
      */}
      <ul className="flex flex-col gap-2">
        {draft.days.map((day, index) => {
          const dayName = t(DAY_KEYS[index] ?? 'tenant.dayMon')
          return (
            <li key={DAY_KEYS[index]} className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-sm text-muted-foreground">{dayName}</span>
              {day === null ? (
                <>
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {t('tenant.dayClosed')}
                  </span>
                  <IconAction
                    label={t('tenant.dayOpenItOn', { day: dayName })}
                    onClick={() => { setDay(index, { open: '09:00', close: '18:00' }) }}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </IconAction>
                </>
              ) : (
                <>
                  <TimeField
                    label={t('tenant.dayOpensAt', { day: dayName })}
                    value={day.open}
                    onChange={(value) => { setDay(index, { ...day, open: value }) }}
                  />
                  <span aria-hidden="true" className="shrink-0 text-muted-foreground">–</span>
                  <TimeField
                    label={t('tenant.dayClosesAt', { day: dayName })}
                    value={day.close}
                    onChange={(value) => { setDay(index, { ...day, close: value }) }}
                  />
                  <IconAction
                    label={t('tenant.dayCloseItOn', { day: dayName })}
                    onClick={() => { setDay(index, null) }}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </IconAction>
                </>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`hours-note-${tenantId}`}>{t('tenant.hoursNoteLabel')}</Label>
        <Input
          id={`hours-note-${tenantId}`}
          maxLength={160}
          placeholder={t('tenant.hoursNotePlaceholder')}
          value={draft.note}
          onChange={(event) => { setDraft({ ...draft, note: event.target.value }) }}
        />
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={invalid || save.isPending}
          onClick={() => { save.mutate({ ...draft, enabled: true }) }}
        >
          {save.isPending ? t('tenant.hoursSaving') : t('tenant.hoursPublish')}
        </Button>
        {initial.enabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() => { save.mutate({ ...draft, enabled: false }) }}
          >
            {t('tenant.hoursUnpublish')}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

/**
 * `<input type="time">`, which on a phone is the OS time wheel rather than a
 * keyboard — the difference between two taps and eight, and sellers do this
 * standing up. It hands back `HH:MM` in 24-hour form regardless of the device's
 * 12-hour display, which is exactly what is stored.
 */
function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    // The wrapper is what shrinks. `min-w-0 flex-1` on the input itself did not:
    // `Input` carries `text-base` on mobile (iOS zooms anything smaller), so a
    // `<input type="time">` has a ~145px intrinsic width, and two of them plus a
    // label and a button overflowed a 390px column by 23px. A block-level flex
    // item with `min-w-0` shrinks reliably; the input just fills it.
    <span className="min-w-0 flex-1">
      <Input
        type="time"
        aria-label={label}
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
        className="w-full px-2"
      />
    </span>
  )
}

/** A 44px square action with a real name for anything that is not looking. */
function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function BlockHeading({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Clock
  title: string
  hint: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function BlockSkeleton() {
  return <div className="h-24 animate-pulse rounded-lg bg-muted/60" aria-hidden="true" />
}

/**
 * A switch built from a button, not a checkbox.
 *
 * 44px of touch target either way, and `aria-pressed` rather than `role=switch`
 * so it reads correctly in the screen readers that ship on the phones sellers
 * actually use.
 */
function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
      className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50 disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-5 rounded-full bg-background transition-[left]',
            checked ? 'left-[1.125rem]' : 'left-0.5',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

/** A PostgREST error is a plain object, not an `Error`. Fourth time in this repo. */
function describe(cause: unknown, t: Translate): string {
  const message = errorMessage(cause)
  if (message === '') return t('errors.unexpected')
  if (message.toLowerCase().includes('permission') || message.includes('42501')) {
    return t('tenant.panelReadOnly')
  }
  return message
}
