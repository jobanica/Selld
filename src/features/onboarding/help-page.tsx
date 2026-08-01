import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Help, in the words sellers use.
 *
 * Eight questions, and every one of them is a question somebody actually asks
 * before they message support — "saan ko makikita ang link ko", "may bawas ba
 * kayo", "paano kung ayaw tanggapin". A help centre organised by *feature* is
 * organised for the people who built it; this is organised by the order the
 * questions occur to somebody who signed up ten minutes ago.
 *
 * Written directly in both locales rather than translated from the English. Hard
 * rule 5 asks for Taglish, and Taglish is not English with Tagalog words
 * substituted — "Tatlong bagay lang" is how a seller would say it and "Three
 * things only" back-translated is not.
 */
const QUESTIONS = [
  { q: 'help.q1', a: 'help.a1' },
  { q: 'help.q2', a: 'help.a2' },
  { q: 'help.q3', a: 'help.a3' },
  { q: 'help.q4', a: 'help.a4' },
  { q: 'help.q5', a: 'help.a5' },
  { q: 'help.q6', a: 'help.a6' },
  { q: 'help.q7', a: 'help.a7' },
  { q: 'help.q8', a: 'help.a8' },
] as const

export function HelpPage() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <HelpCircle className="size-5" aria-hidden="true" />
          {t('help.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('help.subtitle')}</p>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="sr-only">{t('help.title')}</CardTitle>
          <CardDescription className="sr-only">{t('help.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {QUESTIONS.map((entry) => (
            // <details> rather than a controlled accordion: it works before
            // hydration, it is keyboard-accessible for free, and a seller opening
            // three at once is a reasonable thing to want.
            <details key={entry.q} className="group py-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-medium">
                {t(entry.q)}
              </summary>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(entry.a)}</p>
            </details>
          ))}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">{t('help.contact')}</p>
    </div>
  )
}
