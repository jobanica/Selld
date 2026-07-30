import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'

export function NotFound() {
  const { t } = useTranslation()

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-start gap-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t('errors.notFound')}</h1>
      <p className="text-sm text-muted-foreground">{t('errors.notFoundBody')}</p>
      <Button asChild>
        <Link to="/">{t('errors.backToDashboard')}</Link>
      </Button>
    </div>
  )
}
