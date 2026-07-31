import { useQuery } from '@tanstack/react-query'
import { MessageCircle, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatManilaDateTime } from '@/lib/time/manila'

import { AutoRepliesPanel } from './auto-replies-panel'
import { ConnectPanel } from './connect-panel'
import { fetchThreads, type InboxThread } from './inbox-api'
import { ThreadPanel } from './thread-panel'

/**
 * The unified inbox.
 *
 * One list, one conversation, and the messaging window on every row — because the
 * question an agent has before they type is not "what did they say" but "can I
 * still answer this". A seller working down an inbox on a phone between packing
 * two orders needs the closing ones first, and that is what the list is sorted and
 * badged for.
 *
 * The conversation takes over the whole screen at 390px rather than sitting beside
 * the list: a two-pane inbox on a phone is two half-unusable panes.
 */
export function InboxPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const [openId, setOpenId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const threads = useQuery({
    queryKey: ['inbox-threads', tenant.id],
    queryFn: () => fetchThreads(tenant.id, 'open'),
    // A conversation that closes while the seller is reading it is the failure
    // this screen exists to prevent, so the countdown has to move on its own.
    refetchInterval: 20_000,
  })

  if (openId !== null) {
    return <ThreadPanel threadId={openId} onClose={() => setOpenId(null)} />
  }

  const rows = threads.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-headline text-2xl font-bold tracking-tight">{t('inbox.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('inbox.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((open) => !open)}
        >
          <Settings2 className="mr-2 size-4" aria-hidden="true" />
          {t('inbox.settingsAction')}
        </Button>
      </header>

      {showSettings && (
        <div className="flex flex-col gap-6">
          <ConnectPanel />
          <AutoRepliesPanel />
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4" aria-hidden="true" />
            {t('inbox.threadsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('inbox.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {rows.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-col gap-1 py-3 text-left"
                    onClick={() => setOpenId(thread.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{thread.customerName ?? thread.name}</span>
                      {thread.unread > 0 && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                          {thread.unread}
                        </span>
                      )}
                      <WindowBadge hoursLeft={thread.windowHoursLeft} />
                      {thread.customerOrders !== null && thread.customerOrders > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {t('inbox.orderCount', { count: thread.customerOrders })}
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-1 text-sm text-muted-foreground">
                      {thread.snippet ?? ''}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {thread.lastMessageAt === null
                        ? ''
                        : formatManilaDateTime(thread.lastMessageAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * How long is left to answer.
 *
 * Rendered as hours rather than a timestamp because that is the decision being
 * made — "answer this one first" — and a closing conversation is styled as a
 * warning rather than as information, since by the time it reads 0 the seller has
 * lost the ability to reply at all.
 */
export function WindowBadge({ hoursLeft }: { hoursLeft: number | null }) {
  const { t } = useTranslation()

  if (hoursLeft === null) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t('inbox.windowNone')}
      </span>
    )
  }
  if (hoursLeft <= 0) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t('inbox.windowClosed')}
      </span>
    )
  }

  const closing = hoursLeft <= 4
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        closing ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
    >
      {hoursLeft < 1
        ? t('inbox.windowMinutes', { count: Math.max(Math.round(hoursLeft * 60), 1) })
        : t('inbox.windowHours', { count: Math.round(hoursLeft) })}
    </span>
  )
}

export type { InboxThread }
