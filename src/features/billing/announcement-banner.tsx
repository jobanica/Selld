import { useQuery } from '@tanstack/react-query'
import { Info, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useActiveTenant } from '@/features/tenancy/use-tenant'

import { fetchAnnouncements, fetchSubscription } from './billing-api'

/**
 * What the seller has to know before anything else on the screen.
 *
 * Two sources, one strip: the billing state when it needs action, and whatever
 * Selld or their reseller is currently announcing. Billing goes first because it
 * is the only one that is about *them*.
 *
 * The billing line is deliberately not shown for a healthy account. A permanent
 * "you are on Growth, ₱1,499/mo" banner is a line sellers learn to look past, and
 * then they look past the one that says their card bounced.
 */
export function AnnouncementBanner() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const subscription = useQuery({
    queryKey: ['billing', tenant.id],
    queryFn: () => fetchSubscription(tenant.id),
    staleTime: 60_000,
  })
  const announcements = useQuery({
    queryKey: ['announcements', tenant.id],
    queryFn: () => fetchAnnouncements(tenant.id),
    staleTime: 5 * 60_000,
  })

  const status = subscription.data?.status
  const billingNotice =
    status === 'past_due'
      ? ({ level: 'warning', key: 'billing.bannerPastDue' } as const)
      : status === 'restricted'
        ? ({ level: 'critical', key: 'billing.bannerRestricted' } as const)
        : status === 'trialing'
          ? ({ level: 'info', key: 'billing.bannerTrialing' } as const)
          : null

  const notices = announcements.data ?? []
  if (billingNotice === null && notices.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      {billingNotice === null ? null : (
        <div className={strip(billingNotice.level)}>
          {icon(billingNotice.level)}
          <p className="min-w-0 flex-1">
            {t(billingNotice.key)}{' '}
            <Link to="/billing" className="underline underline-offset-2">
              {t('billing.bannerAction')}
            </Link>
          </p>
        </div>
      )}
      {notices.map((notice) => (
        <div key={notice.id} className={strip(notice.level)}>
          {icon(notice.level)}
          <p className="min-w-0 flex-1">
            <span className="font-medium">{notice.title}</span> {notice.body}
          </p>
        </div>
      ))}
    </div>
  )
}

function strip(level: 'info' | 'warning' | 'critical'): string {
  const base = 'flex items-start gap-2 rounded-md border p-3 text-sm'
  if (level === 'critical') return `${base} border-destructive/40 bg-destructive/5 text-destructive`
  if (level === 'warning') return `${base} border-amber-500/40 bg-amber-500/5`
  return `${base} border-border bg-muted/40`
}

function icon(level: 'info' | 'warning' | 'critical') {
  const Icon = level === 'info' ? Info : TriangleAlert
  return <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
}
