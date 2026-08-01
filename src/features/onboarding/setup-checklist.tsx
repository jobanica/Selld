import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { getSupabase } from '@/lib/supabase/client'

/**
 * What is still standing between this store and its first order.
 *
 * The phase-20 done-when is "a fresh signup can go live and process a real paid
 * order with **zero support contact**", and the reason a new seller messages
 * support is almost never that a screen was confusing — it is that they do not
 * know what is left. The onboarding wizard gets them through five decisions and
 * then stops, and a dashboard full of zeroes says nothing about why.
 *
 * So this is a checklist and not a tour. A tour explains the screen you are
 * already on; a checklist tells you the screen you have not opened yet. It
 * disappears entirely once everything is done, because a permanent "well done"
 * panel is a line sellers learn to look past — and then they look past the
 * banner that says their card bounced.
 *
 * Each item links straight to the thing, in Taglish. "Wala pang produkto" with a
 * link is a task; "Set up your catalog" is a slogan.
 */
interface Progress {
  products: number
  shipping: number
  payments: number
  orders: number
}

async function fetchProgress(tenantId: string): Promise<Progress> {
  const client = getSupabase()
  // Four counts, one round trip each, deliberately head-only: the numbers are
  // all this needs and pulling the rows to count them would be the home screen
  // paying for a checklist.
  const count = async (table: 'products' | 'shipping_rates' | 'payment_accounts' | 'orders') => {
    const { count: n } = await client
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
    return n ?? 0
  }
  const [products, shipping, payments, orders] = await Promise.all([
    count('products'),
    count('shipping_rates'),
    count('payment_accounts'),
    count('orders'),
  ])
  return { products, shipping, payments, orders }
}

export function SetupChecklist() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const progress = useQuery({
    queryKey: ['setup-progress', tenant.id],
    queryFn: () => fetchProgress(tenant.id),
    staleTime: 60_000,
  })

  const data = progress.data
  if (data === undefined) return null

  const items = [
    { key: 'products', done: data.products > 0, to: '/products', label: t('setup.addProduct') },
    { key: 'shipping', done: data.shipping > 0, to: '/shipping', label: t('setup.setShipping') },
    // Payments is genuinely optional: a store that takes COD only is a complete,
    // working store, and marking it "incomplete" would tell a seller who has
    // deliberately chosen COD that they have failed a step.
    { key: 'payments', done: data.payments > 0, to: '/payments', label: t('setup.addPayments'), optional: true },
    { key: 'share', done: data.orders > 0, to: '/', label: t('setup.shareStore') },
  ]

  const required = items.filter((item) => item.optional !== true)
  if (required.every((item) => item.done)) return null

  return (
    <Card data-testid="setup-checklist" className="border-primary/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('setup.title')}</CardTitle>
        <CardDescription>
          {t('setup.remaining', { count: required.filter((item) => !item.done).length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => (
          <Link
            key={item.key}
            to={item.to}
            className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
          >
            {item.done ? (
              <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={item.done ? 'min-w-0 flex-1 text-muted-foreground line-through' : 'min-w-0 flex-1'}>
              {item.label}
              {item.optional === true ? (
                <span className="ml-1 text-xs text-muted-foreground">{t('setup.optional')}</span>
              ) : null}
            </span>
            {item.done ? null : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
