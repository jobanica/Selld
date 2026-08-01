import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet } from 'react-router-dom'

import { LocaleSwitcher } from '@/components/locale-switcher'
import { UserMenu } from '@/features/auth/user-menu'

/**
 * Shell for the two surfaces that are not a store.
 *
 * Selld's own console and a white-label partner's console have no tenant, so they
 * cannot use the dashboard shell — no tenant switcher, no announcement banner, no
 * seller navigation. Deliberately plain: these screens belong to people who
 * already know what they came for, and dressing them up as the seller product
 * would suggest a store exists behind them.
 */
export function ConsoleLayout() {
  const { t } = useTranslation()
  return (
    <div className="min-h-dvh bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-3 sm:px-6">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 font-semibold">
          <ShieldCheck className="size-5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t('app.name')}</span>
        </Link>
        <LocaleSwitcher />
        <UserMenu />
      </header>
      <main className="px-3 py-5 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
