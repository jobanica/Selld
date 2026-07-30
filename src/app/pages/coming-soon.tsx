import { Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ALL_NAV_ITEMS } from '@/app/navigation'

/**
 * Placeholder for navigation destinations whose phase has not shipped.
 *
 * Better than a 404: the information architecture is already visible and
 * navigable, and each route states which phase fills it in.
 */
export function ComingSoon() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const item = ALL_NAV_ITEMS.find((candidate) => candidate.to === pathname)

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader className="items-start gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Construction className="size-5" aria-hidden="true" />
          </span>
          <CardTitle>{item ? t(`nav.${item.labelKey}`) : t('common.comingSoon')}</CardTitle>
          <CardDescription>
            {item
              ? `${t('common.comingSoon')} — phase ${item.phase}.`
              : t('common.comingSoon')}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
