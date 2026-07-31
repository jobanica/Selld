import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bot, Send, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatManilaDateTime } from '@/lib/time/manila'

import {
  describeInboxError,
  fetchConversation,
  markRead,
  sendReply,
  type InboxMessage,
} from './inbox-api'
import { WindowBadge } from './inbox-page'

/**
 * One conversation.
 *
 * The reply box is disabled when the window is closed, with the reason in place of
 * the placeholder — rather than accepting the text and failing on send. A seller
 * who types a paragraph and then learns it cannot be delivered has been told about
 * the rule at exactly the wrong moment.
 *
 * A tag is offered only when the window has closed, and only the ones an automation
 * is allowed to use plus `HUMAN_AGENT`, which is legitimate here precisely because
 * a person is typing. It is deliberately not the first option: reaching for a tag
 * as a matter of course is the misuse that costs a page its messaging permission.
 */
export function ThreadPanel({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState('')
  const [tag, setTag] = useState('')
  const [error, setError] = useState<string | null>(null)

  const conversation = useQuery({
    queryKey: ['inbox-thread', threadId],
    queryFn: () => fetchConversation(threadId),
    refetchInterval: 15_000,
  })

  // Marking read is a side effect of opening, not of rendering: driven from the id
  // rather than from the query result, so a refetch does not fire it again.
  useEffect(() => {
    void markRead(threadId).catch(() => {})
  }, [threadId])

  const reply = useMutation({
    mutationFn: () =>
      sendReply({ threadId, body: draft.trim(), tag: tag === '' ? null : tag }),
    onSuccess: async () => {
      setDraft('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['inbox-thread', threadId] })
      await queryClient.invalidateQueries({ queryKey: ['inbox-threads', tenant.id] })
    },
    onError: (cause) => setError(describeInboxError(cause)),
  })

  const data = conversation.data
  const window = data?.sendWindow
  const blocked = window?.verdict === 'blocked'
  const canSendUntagged = !blocked
  const canSend = canSendUntagged || tag !== ''

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="h-11 px-2" onClick={onClose}>
          <ArrowLeft className="mr-1 size-4" aria-hidden="true" />
          {t('inbox.backAction')}
        </Button>
        <h1 className="font-headline text-xl font-bold tracking-tight">
          {data?.customer?.name ?? data?.name ?? ''}
        </h1>
        <WindowBadge hoursLeft={window?.hoursLeft ?? (blocked ? 0 : null)} />
      </header>

      {data?.customer != null && (
        <p className="text-sm text-muted-foreground">
          {data.customer.phone} · {t('inbox.orderCount', { count: data.customer.orders })}
        </p>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('inbox.conversationTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-3">
            {(data?.messages ?? []).map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inbox-reply">{t('inbox.replyLabel')}</Label>
            <Input
              id="inbox-reply"
              value={draft}
              disabled={blocked && tag === ''}
              placeholder={
                blocked
                  ? t(WINDOW_REASONS[window?.reason ?? 'window_closed'] ?? 'inbox.windowClosedHint')
                  : t('inbox.replyPlaceholder')
              }
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>

          {blocked && window?.reason !== 'never_messaged_us' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inbox-tag">{t('inbox.tagLabel')}</Label>
              <select
                id="inbox-tag"
                className="h-11 rounded-lg border bg-background px-3 text-sm"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">{t('inbox.tagNone')}</option>
                <option value="POST_PURCHASE_UPDATE">{t('inbox.tagPostPurchase')}</option>
                <option value="CONFIRMED_EVENT_UPDATE">{t('inbox.tagConfirmedEvent')}</option>
                <option value="ACCOUNT_UPDATE">{t('inbox.tagAccount')}</option>
                <option value="HUMAN_AGENT">{t('inbox.tagHumanAgent')}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t('inbox.tagHint')}</p>
            </div>
          )}

          {error !== null && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t(error as 'inbox.errorUnknown')}
            </p>
          )}

          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={draft.trim() === '' || !canSend || reply.isPending}
            onClick={() => reply.mutate()}
          >
            <Send className="mr-2 size-4" aria-hidden="true" />
            {reply.isPending ? t('inbox.sending') : t('inbox.sendAction')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

const WINDOW_REASONS: Record<string, 'inbox.windowClosedHint' | 'inbox.windowNeverHint'> = {
  window_closed: 'inbox.windowClosedHint',
  never_messaged_us: 'inbox.windowNeverHint',
}

function MessageRow({ message }: { message: InboxMessage }) {
  const { t } = useTranslation()
  const inbound = message.direction === 'in'

  return (
    <li className={`flex flex-col gap-1 ${inbound ? 'items-start' : 'items-end'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          inbound ? 'bg-muted' : 'bg-primary text-primary-foreground'
        } ${message.status === 'failed' ? 'opacity-60' : ''}`}
      >
        {message.body ?? ''}
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {message.source === 'auto_reply' || message.source === 'comment_reply' ? (
          <Bot className="size-3" aria-hidden="true" />
        ) : (
          <User className="size-3" aria-hidden="true" />
        )}
        {formatManilaDateTime(message.sentAt)}
        {message.tag !== null && ` · ${message.tag}`}
        {message.status === 'failed' && ` · ${t('inbox.notDelivered')}`}
      </span>
    </li>
  )
}
