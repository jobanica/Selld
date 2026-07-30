import { Check, ChevronsUpDown, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTenant } from '@/features/tenancy/use-tenant'
import { cn } from '@/lib/utils'

/**
 * Tenant switcher.
 *
 * Renders as static text when the seller has exactly one store, which is the
 * common case — a dropdown that can only ever have one option is noise, and it
 * costs a tap on a 390px viewport where taps are the scarce resource.
 */
export function TenantSwitcher() {
  const { t } = useTranslation()
  const { tenants, activeTenant, setActiveTenant, isLoading } = useTenant()

  if (isLoading) {
    return (
      <div
        className="h-9 w-32 animate-pulse rounded-md bg-muted"
        aria-label={t('common.loading')}
      />
    )
  }

  if (!activeTenant) return null

  if (tenants.length === 1) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2 text-sm font-medium">
        <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{activeTenant.name}</span>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 gap-2"
          data-testid="tenant-switcher"
          aria-label={t('tenant.switchStore')}
        >
          <Store className="size-4 shrink-0" aria-hidden="true" />
          <span className="max-w-[8rem] truncate sm:max-w-[12rem]">{activeTenant.name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        <DropdownMenuLabel>{t('tenant.yourStores')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tenants.map((tenant) => {
          const isActive = tenant.id === activeTenant.id
          return (
            <DropdownMenuItem
              key={tenant.id}
              onSelect={() => setActiveTenant(tenant.id)}
              className="gap-2"
            >
              <Check
                className={cn('size-4 shrink-0', isActive ? 'opacity-100' : 'opacity-0')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tenant.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(`tenant.role.${tenant.role}`)}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
