import { TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

/**
 * One KPI tile: label, icon chip, the number, and how it moved.
 *
 * The delta is `null` whenever the previous period had nothing to compare
 * against, and then no chip is rendered at all. A seller in their first week
 * would otherwise see "+100%" on every tile, which reads as growth and is
 * actually just division by a small number.
 *
 * `tone` colours the *value*, not the card. A dashboard where a whole tile turns
 * red is a dashboard sellers learn to avoid opening; the number carries the news
 * and the rest of the card stays calm.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  iconTone = 'brand',
  delta,
  tone = 'neutral',
  emphasis = false,
}: {
  label: string
  value: string
  hint?: string
  icon: LucideIcon
  iconTone?: 'brand' | 'warning' | 'success'
  /** Percent change against the previous period; null hides the chip. */
  delta?: number | null
  tone?: 'neutral' | 'positive' | 'negative'
  emphasis?: boolean
}) {
  const { t } = useTranslation()
  const up = (delta ?? 0) >= 0

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-lg',
            iconTone === 'warning' && 'bg-amber-100 text-amber-700',
            iconTone === 'success' && 'bg-emerald-100 text-emerald-700',
            iconTone === 'brand' && 'bg-primary/10 text-primary',
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>

      <p
        className={cn(
          'font-headline tabular-nums leading-none tracking-tight',
          emphasis ? 'text-3xl font-bold sm:text-4xl' : 'text-2xl font-bold',
          tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'negative' && 'text-destructive',
        )}
      >
        {value}
      </p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {delta !== null && delta !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold',
              up ? 'bg-emerald-100 text-emerald-700' : 'bg-destructive/10 text-destructive',
            )}
          >
            {up ? (
              <TrendingUp className="size-3" aria-hidden="true" />
            ) : (
              <TrendingDown className="size-3" aria-hidden="true" />
            )}
            {up ? '+' : ''}
            {delta}%
          </span>
        )}
        {delta !== null && delta !== undefined && (
          <span className="text-xs text-muted-foreground">{t('analytics.vsLastPeriod')}</span>
        )}
        {hint !== undefined && (
          <span className="text-xs leading-snug text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  )
}
