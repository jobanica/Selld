import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Radio } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatManilaDateTime } from '@/lib/time/manila'

import { createSession, describeLiveError, fetchSessions } from './live-api'
import { LiveConsolePanel } from './live-console'

/**
 * Live selling.
 *
 * A list of sessions and a way to start one, with the console taking over the whole
 * screen once a session is open — because during a broadcast the seller is holding
 * a phone in one hand and a blouse in the other, and anything that is not the board
 * or the claim feed is in the way.
 */
export function LivePage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [openId, setOpenId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const sessions = useQuery({
    queryKey: ['live-sessions', tenant.id],
    queryFn: () => fetchSessions(tenant.id),
  })

  const start = useMutation({
    mutationFn: () =>
      createSession({
        tenantId: tenant.id,
        title: title.trim(),
        externalRef: ref.trim() === '' ? null : ref.trim(),
        windowMinutes: 30,
      }),
    onSuccess: async (session) => {
      setTitle('')
      setRef('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['live-sessions', tenant.id] })
      setOpenId(session.id)
    },
    onError: (cause) => setError(describeLiveError(cause)),
  })

  if (openId !== null) {
    return <LiveConsolePanel sessionId={openId} onClose={() => setOpenId(null)} />
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-headline text-2xl font-bold tracking-tight">{t('live.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('live.subtitle')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4" aria-hidden="true" />
            {t('live.startTitle')}
          </CardTitle>
          <CardDescription>{t('live.startSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="live-title">{t('live.titleLabel')}</Label>
            <Input
              id="live-title"
              value={title}
              placeholder={t('live.titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="live-ref">{t('live.refLabel')}</Label>
            <Input
              id="live-ref"
              value={ref}
              placeholder={t('live.refPlaceholder')}
              onChange={(event) => setRef(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('live.refHint')}</p>
          </div>

          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'live.errorUnknown')}
            </p>
          )}

          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={title.trim() === '' || start.isPending}
            onClick={() => start.mutate()}
          >
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {start.isPending ? t('live.starting') : t('live.startAction')}
          </Button>
        </CardContent>
      </Card>

      {(sessions.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('live.historyTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {(sessions.data ?? []).map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-1 py-3 text-left"
                    onClick={() => setOpenId(session.id)}
                  >
                    <span className="font-medium">{session.title}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[session.status]}`}
                    >
                      {t(STATUS_LABELS[session.status])}
                    </span>
                    <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                      {t('live.claimCount', { count: session.claimCount })}
                    </span>
                    <span className="w-full text-xs text-muted-foreground">
                      {formatManilaDateTime(session.startedAt ?? session.createdAt)} ·{' '}
                      {t('live.itemCount', { count: session.itemCount })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const STATUS_LABELS = {
  draft: 'live.statusDraft',
  live: 'live.statusLive',
  ended: 'live.statusEnded',
} as const

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  live: 'bg-destructive/15 text-destructive',
  ended: 'bg-muted text-muted-foreground',
}
