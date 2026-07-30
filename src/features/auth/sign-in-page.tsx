import { Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LocaleSwitcher } from '@/components/locale-switcher'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AuthValidationError,
  requestEmailOtp,
  requestPhoneOtp,
  verifyOtp,
  type OtpChannel,
} from '@/features/auth/auth-api'
import type { Translate } from '@/lib/i18n'
import { hasSupabaseConfig } from '@/lib/env'
import { cn } from '@/lib/utils'

type Step =
  | { name: 'request' }
  | { name: 'verify'; channel: OtpChannel; destination: string; rawDestination: string }

/**
 * Sign in with a 6-digit OTP, by SMS or email.
 *
 * Mobile-first: number pad keyboards via `inputMode`, `autoComplete="one-time-code"`
 * so both iOS and Android offer to autofill the code from the SMS, and no password
 * field anywhere — sellers reuse passwords and forget them, and an OTP removes a
 * whole class of support requests.
 */
export function SignInPage() {
  const { t } = useTranslation()
  const [channel, setChannel] = useState<OtpChannel>('phone')
  const [step, setStep] = useState<Step>({ name: 'request' })
  const [value, setValue] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const configured = hasSupabaseConfig()

  async function handleRequest(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result =
        channel === 'phone' ? await requestPhoneOtp(value) : await requestEmailOtp(value)
      setStep({
        name: 'verify',
        channel: result.channel,
        destination: result.destination,
        rawDestination: value,
      })
      setCode('')
    } catch (cause) {
      setError(messageFor(cause, t))
    } finally {
      setBusy(false)
    }
  }

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault()
    if (step.name !== 'verify') return
    setError(null)
    setBusy(true)
    try {
      // On success the SessionProvider picks up the new session and the router
      // swaps this page out — nothing to navigate to explicitly.
      await verifyOtp({ channel: step.channel, destination: step.rawDestination, code })
    } catch (cause) {
      setError(messageFor(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="flex h-14 items-center justify-between px-4">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Store className="size-4" aria-hidden="true" />
          </span>
          {t('app.name')}
        </span>
        <LocaleSwitcher />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-10 pt-4 sm:items-center sm:pt-0">
        <Card className="w-full max-w-sm">
          {step.name === 'request' ? (
            <>
              <CardHeader>
                <CardTitle>{t('auth.signInTitle')}</CardTitle>
                <CardDescription>{t('auth.signInSubtitle')}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleRequest} className="flex flex-col gap-4">
                  <div
                    role="tablist"
                    aria-label={t('auth.signInTitle')}
                    className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
                  >
                    {(['phone', 'email'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="tab"
                        aria-selected={channel === option}
                        onClick={() => {
                          setChannel(option)
                          setValue('')
                          setError(null)
                        }}
                        className={cn(
                          'min-h-9 rounded px-3 text-sm font-medium transition-colors',
                          channel === option
                            ? 'bg-background shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {option === 'phone' ? t('auth.useMobile') : t('auth.useEmail')}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sign-in-destination">
                      {channel === 'phone' ? t('auth.mobileLabel') : t('auth.emailLabel')}
                    </Label>
                    <Input
                      id="sign-in-destination"
                      name={channel === 'phone' ? 'tel' : 'email'}
                      type={channel === 'phone' ? 'tel' : 'email'}
                      inputMode={channel === 'phone' ? 'tel' : 'email'}
                      autoComplete={channel === 'phone' ? 'tel' : 'email'}
                      autoCapitalize="none"
                      autoCorrect="off"
                      required
                      placeholder={
                        channel === 'phone'
                          ? t('auth.mobilePlaceholder')
                          : t('auth.emailPlaceholder')
                      }
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      aria-invalid={error !== null}
                      aria-describedby={error ? 'sign-in-error' : undefined}
                    />
                  </div>

                  {error && <ErrorText id="sign-in-error">{error}</ErrorText>}
                  {!configured && <ErrorText>{t('auth.unconfigured')}</ErrorText>}

                  <Button type="submit" disabled={busy || !configured} className="w-full">
                    {busy ? t('auth.sending') : t('auth.sendCode')}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>{t('auth.codeTitle')}</CardTitle>
                <CardDescription>
                  {t('auth.codeSentTo', { destination: step.destination })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleVerify} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sign-in-code">{t('auth.codeLabel')}</Label>
                    <Input
                      id="sign-in-code"
                      // Lets iOS and Android autofill the code straight from the SMS.
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      autoFocus
                      className="text-center text-lg tracking-[0.4em]"
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      aria-invalid={error !== null}
                      aria-describedby={error ? 'verify-error' : undefined}
                    />
                  </div>

                  {error && <ErrorText id="verify-error">{error}</ErrorText>}

                  <Button type="submit" disabled={busy} className="w-full">
                    {busy ? t('auth.verifying') : t('auth.verify')}
                  </Button>

                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setStep({ name: 'request' })
                        setError(null)
                      }}
                    >
                      {t('auth.changeDestination')}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </main>
    </div>
  )
}

function ErrorText({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

/** Map thrown errors to a translated, non-leaky message. */
function messageFor(cause: unknown, t: Translate): string {
  if (cause instanceof AuthValidationError) {
    switch (cause.field) {
      case 'email':
        return t('auth.invalidEmail')
      case 'code':
        return t('auth.invalidCode')
      case 'phone':
        return cause.message.includes('mobile numbers')
          ? t('auth.landlineNotAllowed')
          : t('auth.invalidPhone')
    }
  }
  if (cause instanceof Error && cause.message) return cause.message
  return t('errors.unexpected')
}
