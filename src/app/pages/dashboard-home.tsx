import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { centavos, formatPHP, type Centavos } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

/**
 * Phase 0 dashboard home.
 *
 * Deliberately renders zeroed metrics from real formatters rather than fake
 * sample numbers: it proves the money and time layers are wired end to end, and
 * it will not be mistaken for working data during a demo.
 *
 * The commission-kept tile leads because it is the retention mechanic from the
 * offer doc — the number a seller logs in to see.
 */
export function DashboardHome() {
  const { t } = useTranslation()

  const metrics: { key: string; label: string; value: string; hint?: string }[] = [
    {
      key: 'commission',
      label: t('dashboard.metricCommissionKept'),
      value: formatPHP(ZERO_CENTAVOS),
      hint: t('dashboard.metricCommissionKeptHint'),
    },
    { key: 'revenue', label: t('dashboard.metricRevenue'), value: formatPHP(ZERO_CENTAVOS) },
    { key: 'orders', label: t('dashboard.metricOrders'), value: '0' },
    { key: 'packing', label: t('dashboard.metricAwaitingPacking'), value: '0' },
  ]

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {formatManilaDate(new Date())} · {t('app.tagline')}
        </p>
      </header>

      {/* items-start so a card with a hint does not stretch its whole row and
          leave dead space in the tiles beside it. */}
      <section
        aria-label={t('dashboard.title')}
        className="grid grid-cols-2 items-start gap-3 lg:grid-cols-4"
      >
        {metrics.map((metric) => (
          <Card key={metric.key}>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs">{metric.label}</CardDescription>
              <CardTitle className="text-xl tabular sm:text-2xl">{metric.value}</CardTitle>
            </CardHeader>
            {metric.hint && (
              <CardContent className="pt-0">
                <p className="text-xs leading-snug text-muted-foreground">{metric.hint}</p>
              </CardContent>
            )}
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('dashboard.welcome')}</CardTitle>
          <CardDescription>{t('dashboard.foundationNotice')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {FOUNDATION_CHECKLIST.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

/** Zero, via the money layer rather than a hardcoded "₱0.00" string. */
const ZERO_CENTAVOS: Centavos = centavos(0)

/**
 * What phase 0 actually delivered. Intentionally not translated — this is
 * scaffolding copy that disappears once the storefront lands in phase 5.
 */
const FOUNDATION_CHECKLIST = [
  'Centavos-only money layer with proportional allocation',
  'PH phone normalisation to +63 E.164',
  'PSGC reference data — 17 regions, 81 provinces, 1,634 cities, 42,046 barangays',
  'Provider interfaces for couriers, payments, SMS and marketplaces',
  'English / Taglish locale switching',
]
