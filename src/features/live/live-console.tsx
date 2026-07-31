import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus, Radio, Square, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaTime } from '@/lib/time/manila'

import {
  cancelClaim,
  describeLiveError,
  fetchConsole,
  ingestManualComment,
  updateSession,
  type LiveConsole,
} from './live-api'
import { LiveSetup } from './live-setup'

/**
 * The operator console.
 *
 * Full screen, and refreshed every two seconds. Three things, in the order the
 * seller's eye goes:
 *
 * 1. **The board.** What is on offer and how many are left. Tapping a row is what
 *    "I am holding this one up now" means, and it is one tap because it happens
 *    every forty seconds for two hours.
 * 2. **The claim feed.** Newest first, with the comment that produced each claim,
 *    so the seller can see the parser agreeing with them in real time and catch it
 *    when it does not.
 * 3. **What could not be used.** Questions to answer and comments the parser could
 *    not read. A console that only shows successes hides its own failures, and the
 *    failures are what the seller needs to see to trust the rest.
 *
 * Two seconds rather than realtime subscriptions, deliberately. A poll that misses
 * a tick shows a stale count for two seconds; a socket that drops on a Philippine
 * mobile connection — which it will, repeatedly, for two hours — shows a stale
 * count until someone notices and reloads.
 */
export function LiveConsolePanel({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [author, setAuthor] = useState('')

  const console$ = useQuery({
    queryKey: ['live-console', sessionId],
    queryFn: () => fetchConsole(sessionId),
    refetchInterval: 2000,
  })

  const session = console$.data
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['live-console', sessionId] })

  const update = useMutation({
    mutationFn: (input: { status?: 'live' | 'ended'; currentCode?: string }) =>
      updateSession({ sessionId, ...input }),
    onSuccess: async () => {
      setError(null)
      await refresh()
    },
    onError: (cause) => setError(describeLiveError(cause)),
  })

  const drop = useMutation({
    mutationFn: (claimId: string) => cancelClaim(claimId),
    onSuccess: refresh,
    onError: (cause) => setError(describeLiveError(cause)),
  })

  const type$ = useMutation({
    mutationFn: () =>
      ingestManualComment({
        sessionId,
        codes: (session?.items ?? []).map((item) => item.code),
        currentCode: session?.currentCode ?? null,
        // A typed comment has no PSID, so the buyer's name is the identity. Same
        // person, same string, and the operator is the one keeping it consistent.
        psid: `manual:${author.trim().toLowerCase() || 'walk-in'}`,
        authorName: author.trim() === '' ? null : author.trim(),
        body: comment,
      }),
    onSuccess: async () => {
      setComment('')
      setError(null)
      await refresh()
    },
    onError: (cause) => setError(describeLiveError(cause)),
  })

  if (session === undefined || session === null) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  const isLive = session.status === 'live'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-5" aria-hidden="true" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{session.title}</h2>
        {session.status !== 'ended' &&
          (isLive ? (
            <Button
              variant="outline"
              className="h-11"
              onClick={() => update.mutate({ status: 'ended' })}
            >
              <Square className="mr-1.5 size-4" aria-hidden="true" />
              {t('live.endAction')}
            </Button>
          ) : (
            <Button className="h-11" onClick={() => update.mutate({ status: 'live' })}>
              <Radio className="mr-1.5 size-4" aria-hidden="true" />
              {t('live.goLiveAction')}
            </Button>
          ))}
      </header>

      {/* The running total, pinned. It is the number the seller announces. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-2 text-sm">
        <span className="text-lg font-bold tabular">
          {formatPHP(fromDb(session.totals.value))}
        </span>
        <span className="text-muted-foreground">
          {t('live.totalsLine', {
            units: session.totals.units,
            buyers: session.totals.buyers,
          })}
        </span>
        {session.totals.expired > 0 && (
          <span className="text-muted-foreground">
            {t('live.expiredCount', { count: session.totals.expired })}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'live.errorUnknown')}
          </p>
        )}

        {/* ---- The board ------------------------------------------------- */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('live.boardTitle')}</h3>
          {/* One `LiveSetup` instance, always in the same place in the tree.
              Rendering it in two branches unmounts and remounts it the moment the
              first item lands, which resets its open state — so a seller listing
              thirty items before a broadcast had to re-open the panel after every
              single one. */}
          <>
            {session.items.length > 0 && (
              <ul className="flex flex-col gap-2">
                {session.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      // The whole row is the target. During a broadcast the seller
                      // is not aiming.
                      className={`flex min-h-14 w-full items-center gap-3 rounded-lg border p-3 text-left ${
                        item.isCurrent ? 'border-primary bg-primary/5' : ''
                      }`}
                      aria-pressed={item.isCurrent}
                      onClick={() => update.mutate({ currentCode: item.code })}
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted font-bold">
                        {item.code}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatPHP(fromDb(item.price))}
                          {item.variantLabel === null ? '' : ` · ${item.variantLabel}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={`block text-sm font-semibold tabular ${
                            item.remaining === 0 ? 'text-destructive' : ''
                          }`}
                        >
                          {item.remaining === 0
                            ? t('live.soldOut')
                            : t('live.remaining', { count: item.remaining })}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t('live.claimedCount', { count: item.claimed })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <LiveSetup
              session={session}
              onChanged={refresh}
              compact={session.items.length > 0}
            />
          </>
        </section>

        {/* ---- Type a comment -------------------------------------------- */}
        {isLive && (
          <section className="rounded-lg border p-3">
            <h3 className="mb-2 text-sm font-semibold">{t('live.manualTitle')}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{t('live.manualHint')}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label={t('live.manualNameLabel')}
                placeholder={t('live.manualNamePlaceholder')}
                value={author}
                className="sm:w-40"
                onChange={(event) => setAuthor(event.target.value)}
              />
              <Input
                aria-label={t('live.manualCommentLabel')}
                placeholder={t('live.manualCommentPlaceholder')}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && comment.trim() !== '') type$.mutate()
                }}
              />
              <Button
                type="button"
                className="h-11 shrink-0"
                disabled={comment.trim() === '' || type$.isPending}
                onClick={() => type$.mutate()}
              >
                <MessageSquarePlus className="mr-1.5 size-4" aria-hidden="true" />
                {t('live.manualAction')}
              </Button>
            </div>
          </section>
        )}

        {/* ---- The claim feed --------------------------------------------- */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">
            {t('live.feedTitle', { count: session.totals.claims })}
          </h3>
          {session.claims.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              {t('live.feedEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {session.claims.map((claim) => (
                <li key={claim.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded bg-muted text-xs font-bold">
                    {claim.code}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {claim.buyerName ?? claim.psid}
                      {claim.qty > 1 && <span className="text-muted-foreground"> ×{claim.qty}</span>}
                    </span>
                    {/* The comment that produced it. This is how a seller sees the
                        parser working — and catches it when it is wrong. */}
                    {claim.comment !== null && (
                      <span className="block truncate text-xs text-muted-foreground">
                        “{claim.comment}”
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`block text-xs ${CLAIM_STYLES[claim.status]}`}>
                      {t(CLAIM_LABELS[claim.status])}
                    </span>
                    <span className="block text-xs text-muted-foreground tabular">
                      {formatManilaTime(claim.createdAt)}
                    </span>
                  </span>
                  {claim.status === 'reserved' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0"
                      aria-label={t('live.dropClaim')}
                      disabled={drop.isPending}
                      onClick={() => drop.mutate(claim.id)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- What the parser could not use ------------------------------ */}
        {session.unmatched.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold">
              {t('live.unmatchedTitle', { count: session.unmatched.length })}
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">{t('live.unmatchedHint')}</p>
            <ul className="flex flex-col divide-y text-sm">
              {session.unmatched.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                  <span className="font-medium">{entry.authorName ?? entry.psid}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    “{entry.body}”
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(OUTCOME_LABELS[entry.outcome] ?? 'live.outcomeOther')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

const CLAIM_LABELS = {
  reserved: 'live.claimReserved',
  converted: 'live.claimConverted',
  expired: 'live.claimExpired',
  cancelled: 'live.claimCancelled',
} as const

const CLAIM_STYLES: Record<string, string> = {
  reserved: 'text-primary',
  converted: 'text-success',
  expired: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
}

/** Literal keys, spelled out — a template literal would type-check as `string`. */
const OUTCOME_LABELS: Record<string, 'live.outcomeQuestion'> = {
  not_a_claim: 'live.outcomeQuestion',
  unknown_code: 'live.outcomeUnknownCode' as 'live.outcomeQuestion',
  no_item_on_screen: 'live.outcomeNoItem' as 'live.outcomeQuestion',
  sold_out: 'live.outcomeSoldOut' as 'live.outcomeQuestion',
}

export type { LiveConsole }
