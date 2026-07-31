import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, CreditCard } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'

import {
  describePaymentError,
  fetchPaymentAccount,
  savePaymentAccount,
  webhookUrl,
} from './payments-api'

/**
 * Connecting a payment provider.
 *
 * The screen is organised around the two facts a seller needs and cannot get
 * anywhere else: *is my key in?* and *what URL do I paste into Xendit?*
 *
 * It never shows a key back. It cannot — `payment_accounts` has no SELECT grant on
 * the secret columns, so the query that would fetch one fails rather than returning
 * it. What is shown is whether a key is set and its last four characters, which is
 * enough to answer "did my paste work?" and "is this the live key or the test one?"
 * without putting a usable credential on a screen that gets screenshotted into
 * support chats.
 */
export function PaymentsPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [secretKey, setSecretKey] = useState('')
  const [callbackToken, setCallbackToken] = useState('')
  const [isLive, setIsLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const account = useQuery({
    queryKey: ['payment-account', tenant.id],
    queryFn: () => fetchPaymentAccount(tenant.id),
  })

  const save = useMutation({
    mutationFn: (enable: boolean) =>
      savePaymentAccount({
        tenantId: tenant.id,
        secretKey,
        callbackToken,
        isLive,
        isEnabled: enable,
      }),
    onSuccess: async () => {
      // Cleared from component state the moment they are saved. There is no reason
      // for a secret to outlive its own submit, and plenty of reasons not to.
      setSecretKey('')
      setCallbackToken('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['payment-account', tenant.id] })
    },
    onError: (cause) => setError(describePaymentError(cause)),
  })

  const connected = account.data
  const url = webhookUrl(
    connected?.webhookSlug ?? null,
    typeof window === 'undefined' ? '' : window.location.origin,
  )
  const ready =
    (connected?.hasSecretKey ?? false) || secretKey.trim() !== ''
  const canVerify =
    ready && ((connected?.hasCallbackToken ?? false) || callbackToken.trim() !== '')

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('payments.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('payments.intro')}</p>
      </header>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {t(`payments.error.${error}` as 'payments.error.unknown')}
        </p>
      )}

      <Card>
        <CardHeader className="items-start gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <CreditCard className="size-5" aria-hidden="true" />
          </span>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('payments.xendit')}
            {connected?.isEnabled === true && (
              <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                {connected.isLive ? t('payments.live') : t('payments.test')}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {connected?.hasSecretKey === true
              ? t('payments.keySet', { last4: connected.secretKeyLast4 ?? '••••' })
              : t('payments.xenditHint')}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-key">{t('payments.secretKey')}</Label>
            <Input
              id="secret-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                connected?.hasSecretKey === true
                  ? t('payments.leaveBlank')
                  : 'xnd_production_...'
              }
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="callback-token">{t('payments.callbackToken')}</Label>
            <Input
              id="callback-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                connected?.hasCallbackToken === true ? t('payments.leaveBlank') : ''
              }
              value={callbackToken}
              onChange={(event) => setCallbackToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('payments.callbackTokenHint')}</p>
          </div>

          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={isLive}
              onChange={(event) => setIsLive(event.target.checked)}
              className="size-4 accent-[var(--primary)]"
            />
            <span className="text-sm">{t('payments.useLiveKeys')}</span>
          </label>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => save.mutate(true)} disabled={!canVerify || save.isPending}>
              {save.isPending ? t('payments.saving') : t('payments.saveAndEnable')}
            </Button>
            {connected?.isEnabled === true && (
              <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending}>
                {t('payments.disable')}
              </Button>
            )}
          </div>

          {/*
            Said plainly rather than left for a seller to discover from a support
            ticket: until the token is in, nothing can verify a callback, and an
            unverifiable callback is refused rather than trusted.
          */}
          {ready && !canVerify && (
            <p className="text-xs text-muted-foreground">{t('payments.needsToken')}</p>
          )}
        </CardContent>
      </Card>

      {url !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('payments.webhookHeading')}</CardTitle>
            <CardDescription>{t('payments.webhookHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {/*
              Wrapped and scrollable rather than truncated: a seller has to be able
              to select the whole thing, and `text-overflow: ellipsis` silently
              copies the ellipsis on some platforms.
            */}
            <code className="block overflow-x-auto rounded-md bg-muted p-3 text-xs">{url}</code>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {copied ? t('payments.copied') : t('payments.copy')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/*
        Recording a bank transfer or refunding a payment both act on one order, and
        there is no order screen until phase 9. The functions and the API module are
        finished and tested; saying so beats hiding it.
      */}
      <p className="text-xs text-muted-foreground">{t('payments.manualComingWithOrders')}</p>
    </div>
  )
}
