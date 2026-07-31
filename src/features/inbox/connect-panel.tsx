import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Facebook, Link2Off, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'

import { describeInboxError, disconnectAccount, fetchAccounts, startConnect } from './inbox-api'

/**
 * Connecting a Facebook Page.
 *
 * The seller presses one button and is sent to Facebook; everything else happens on
 * the server, because the token that comes back can post as them, read their inbox
 * and message their customers, and a browser is not where that belongs.
 *
 * Two states are surfaced that look like nothing and are not: a token Facebook has
 * expired, and a page that is connected but *not subscribed*. Both leave the
 * integration looking perfectly connected and completely silent, and the seller's
 * only symptom is that nobody messages them any more.
 */
export function ConnectPanel() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const accounts = useQuery({
    queryKey: ['social-accounts', tenant.id],
    queryFn: () => fetchAccounts(tenant.id),
  })

  const connect = useMutation({
    mutationFn: () => startConnect(tenant.id),
    onSuccess: (url) => {
      window.location.href = url
    },
    onError: (cause) => setError(describeInboxError(cause)),
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectAccount(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['social-accounts', tenant.id] })
    },
    onError: (cause) => setError(describeInboxError(cause)),
  })

  const rows = accounts.data ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('inbox.connectTitle')}</CardTitle>
        <CardDescription>{t('inbox.connectSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('inbox.connectNone')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="font-medium">{account.page_name ?? account.page_id}</span>
                {account.ig_user_id !== null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {t('inbox.connectIg')}
                  </span>
                )}
                {account.token_expired && (
                  <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                    <TriangleAlert className="size-3" aria-hidden="true" />
                    {t('inbox.connectExpired')}
                  </span>
                )}
                {!account.webhook_subscribed && (
                  <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                    <TriangleAlert className="size-3" aria-hidden="true" />
                    {t('inbox.connectNotSubscribed')}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="ml-auto h-11"
                  onClick={() => disconnect.mutate(account.id)}
                >
                  <Link2Off className="mr-2 size-4" aria-hidden="true" />
                  {t('inbox.disconnectAction')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'inbox.errorUnknown')}
          </p>
        )}

        <Button
          type="button"
          className="h-11 w-full sm:w-auto"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
        >
          <Facebook className="mr-2 size-4" aria-hidden="true" />
          {rows.length === 0 ? t('inbox.connectAction') : t('inbox.connectAnotherAction')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('inbox.connectHint')}</p>
      </CardContent>
    </Card>
  )
}
