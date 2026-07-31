import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Truck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { getSupabase } from '@/lib/supabase/client'

import {
  describeCourierError,
  fetchCourierAccounts,
  saveCourierProfile,
  setCourierEnabled,
  type CourierId,
} from './couriers-api'

/**
 * Connecting a courier.
 *
 * Lives on the shipping screen rather than getting a nav entry of its own: a seller
 * setting up delivery is doing one job, and "which zones cost what" and "who
 * actually carries the parcel" are two halves of it.
 *
 * The API key is posted to the Node server, not to PostgREST, because it is
 * encrypted with a key this browser does not have. Like the payments screen, it is
 * never shown back — only whether one is set.
 */
export function CourierPanel() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [courier, setCourier] = useState<CourierId>('jnt')
  const [senderName, setSenderName] = useState('')
  const [senderPhone, setSenderPhone] = useState('')
  const [street, setStreet] = useState('')
  const [accountRef, setAccountRef] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const accounts = useQuery({
    queryKey: ['courier-accounts', tenant.id],
    queryFn: () => fetchCourierAccounts(tenant.id),
  })

  const connected = (accounts.data ?? []).find((account) => account.courier === courier)
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['courier-accounts', tenant.id] })

  const save = useMutation({
    mutationFn: async () => {
      await saveCourierProfile({
        tenantId: tenant.id,
        courier,
        senderName: senderName.trim() || (connected?.senderName ?? ''),
        senderPhone: senderPhone.trim() || (connected?.senderPhone ?? ''),
        originAddress: {
          ...(connected?.originAddress ?? {}),
          street: street.trim() || ((connected?.originAddress?.['street'] as string) ?? ''),
        },
        accountRef: accountRef.trim() || (connected?.accountRef ?? ''),
      })

      // Credentials go to the server, which holds the encryption key.
      if (apiKey.trim() !== '') {
        const { data } = await getSupabase().auth.getSession()
        const response = await fetch('/api/couriers/connect', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${data.session?.access_token ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tenantId: tenant.id,
            courier,
            credentials: { apiKey: apiKey.trim(), customerCode: accountRef.trim() },
          }),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'connect_failed')
        }
      }
    },
    onSuccess: async () => {
      setApiKey('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeCourierError(cause)),
  })

  const toggle = useMutation({
    mutationFn: (isEnabled: boolean) =>
      setCourierEnabled({ accountId: connected?.id ?? '', isEnabled }),
    onSuccess: invalidate,
    onError: (cause) => setError(describeCourierError(cause)),
  })

  return (
    <Card>
      <CardHeader className="items-start gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Truck className="size-5" aria-hidden="true" />
        </span>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('couriers.title')}
          {connected?.isEnabled === true && (
            <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
              {t('couriers.on')}
            </span>
          )}
        </CardTitle>
        <CardDescription>{t('couriers.intro')}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {t(`couriers.error.${error}` as 'couriers.error.unknown')}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="courier">{t('couriers.courier')}</Label>
          <Select
            id="courier"
            value={courier}
            onChange={(event) => setCourier(event.target.value as CourierId)}
          >
            <option value="jnt">J&amp;T Express</option>
            <option value="flash">Flash Express</option>
          </Select>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sender-name">{t('couriers.senderName')}</Label>
            <Input
              id="sender-name"
              placeholder={connected?.senderName ?? ''}
              value={senderName}
              onChange={(event) => setSenderName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sender-phone">{t('couriers.senderPhone')}</Label>
            <Input
              id="sender-phone"
              inputMode="tel"
              placeholder={connected?.senderPhone ?? '+639171234567'}
              value={senderPhone}
              onChange={(event) => setSenderPhone(event.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pickup-street">{t('couriers.pickupAddress')}</Label>
          <Input
            id="pickup-street"
            placeholder={(connected?.originAddress?.['street'] as string) ?? ''}
            value={street}
            onChange={(event) => setStreet(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('couriers.pickupHint')}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-ref">{t('couriers.accountRef')}</Label>
            <Input
              id="account-ref"
              placeholder={connected?.accountRef ?? ''}
              value={accountRef}
              onChange={(event) => setAccountRef(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="courier-key">{t('couriers.apiKey')}</Label>
            <Input
              id="courier-key"
              type="password"
              autoComplete="off"
              placeholder={
                connected?.hasCredentials === true ? t('couriers.leaveBlank') : ''
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {/* Said plainly: this is the one field the seller cannot get back. */}
            <p className="text-xs text-muted-foreground">{t('couriers.apiKeyHint')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('couriers.saving') : t('couriers.save')}
          </Button>
          {connected !== undefined && connected.hasCredentials && (
            <Button
              variant="outline"
              onClick={() => toggle.mutate(!connected.isEnabled)}
              disabled={toggle.isPending}
            >
              {connected.isEnabled ? t('couriers.turnOff') : t('couriers.turnOn')}
            </Button>
          )}
        </div>

        {connected !== undefined && !connected.hasCredentials && (
          <p className="text-xs text-muted-foreground">{t('couriers.needsKey')}</p>
        )}
      </CardContent>
    </Card>
  )
}
