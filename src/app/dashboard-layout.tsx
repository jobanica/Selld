import { Menu, Store, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router-dom'

import { LocaleSwitcher } from '@/components/locale-switcher'
import { Button } from '@/components/ui/button'
import { NAV_SECTIONS } from '@/app/navigation'
import { cn } from '@/lib/utils'

/**
 * Dashboard shell.
 *
 * Mobile-first per the hard rule: fully usable at 390px. The sidebar is a
 * slide-over drawer below `lg` and a fixed rail from `lg` up — sellers work from
 * phones, and a desktop-first layout squeezed down is not the same thing as a
 * layout designed for the phone.
 */
export function DashboardLayout() {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Closed on navigation via the link handler rather than a pathname effect —
  // tapping a link is the event, and driving it from an effect causes a
  // cascading render on every route change.
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // Escape closes the drawer, matching the dialog conventions elsewhere.
  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  return (
    <div className="min-h-dvh bg-background">
      {/* Top bar — sticky so the seller never loses navigation in a long order list. */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={t('common.menu')}
          aria-expanded={drawerOpen}
          aria-controls="dashboard-sidebar"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </Button>

        <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Store className="size-4" aria-hidden="true" />
          </span>
          <span>{t('app.name')}</span>
        </NavLink>

        <div className="ml-auto flex items-center gap-1">
          <LocaleSwitcher />
        </div>
      </header>

      <div className="lg:flex">
        {/* Scrim for the mobile drawer. */}
        {drawerOpen && (
          <button
            type="button"
            aria-label={t('common.close')}
            className="fixed inset-0 top-14 z-30 bg-foreground/20 lg:hidden"
            onClick={closeDrawer}
          />
        )}

        <Sidebar id="dashboard-sidebar" open={drawerOpen} onNavigate={closeDrawer} />

        <main className="min-w-0 flex-1 px-3 py-5 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Sidebar({
  id,
  open,
  onNavigate,
}: {
  id: string
  open: boolean
  onNavigate: () => void
}) {
  const { t } = useTranslation()

  return (
    <nav
      id={id}
      aria-label={t('common.menu')}
      className={cn(
        // Mobile: slide-over drawer under the sticky header.
        'fixed inset-y-0 top-14 left-0 z-30 w-64 shrink-0 overflow-y-auto border-r bg-background px-3 py-4 transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : '-translate-x-full',
        // Desktop: a static rail that is always present.
        'lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:translate-x-0',
      )}
    >
      <div className="flex flex-col gap-5">
        {NAV_SECTIONS.map((section) => (
          <div key={section.titleKey} className="flex flex-col gap-1">
            <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`nav.${section.titleKey}`)}
            </p>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-11 items-center gap-3 rounded-md px-2 text-sm transition-colors',
                    isActive
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(`nav.${item.labelKey}`)}</span>
                {item.phase > 0 && (
                  <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular">
                    P{item.phase}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </nav>
  )
}
