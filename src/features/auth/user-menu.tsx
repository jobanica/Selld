import { LogOut, UserRound } from 'lucide-react'
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
import { signOut } from '@/features/auth/auth-api'
import { useSession } from '@/features/auth/use-session'
import { useTenant } from '@/features/tenancy/use-tenant'
import { formatPhPhone } from '@/lib/phone/ph-phone'

/** Account menu: who am I, what is my role here, and sign out. */
export function UserMenu() {
  const { t } = useTranslation()
  const { user } = useSession()
  const { activeTenant } = useTenant()

  if (!user) return null

  // Sellers who signed up by phone have no email, and vice versa.
  const identity = user.email ?? (user.phone ? formatPhPhone(user.phone) : null)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid="user-menu"
          aria-label={t('nav.settings')}
        >
          <UserRound aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium text-foreground">
            {identity ?? t('nav.settings')}
          </span>
          {activeTenant && (
            <span className="block truncate text-xs text-muted-foreground">
              {activeTenant.name} · {t(`tenant.role.${activeTenant.role}`)}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="size-4" aria-hidden="true" />
          {t('auth.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
