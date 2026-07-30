import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isLocale, LOCALE_LABELS } from '@/lib/i18n'
import { useLocale } from '@/lib/i18n/use-locale'

/**
 * Language switcher. Renders as an icon button on phones and gains a text label
 * from `sm` up, since horizontal space is the scarcest thing on a 390px viewport.
 */
export function LocaleSwitcher() {
  const { t } = useTranslation()
  const { locale, setLocale, locales } = useLocale()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          aria-label={t('locale.label')}
          data-testid="locale-switcher"
        >
          <Languages aria-hidden="true" />
          <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('locale.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value)) setLocale(value)
          }}
        >
          {locales.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {LOCALE_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
