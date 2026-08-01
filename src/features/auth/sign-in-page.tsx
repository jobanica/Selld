import { Eye, EyeOff, Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LocaleSwitcher } from '@/components/locale-switcher'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AuthValidationError,
  completePasswordReset,
  MIN_PASSWORD_LENGTH,
  requestEmailOtp,
  requestPasswordReset,
  requestPhoneOtp,
  signInWithPassword,
  verifyOtp,
  type OtpChannel,
} from '@/features/auth/auth-api'
import type { Translate } from '@/lib/i18n'
import { hasSupabaseConfig } from '@/lib/env'
import { errorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils'

type Step =
  | { name: 'request' }
  | { name: 'verify'; channel: OtpChannel; destination: string; rawDestination: string }
  /** Asking which email to reset. */
  | { name: 'reset-request' }
  /** Code plus new password, in one screen. */
  | { name: 'reset-set'; email: string }

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
  /**
   * Password is the default on the email tab, code the default on the phone
   * tab. A phone-first seller often has no working email; an email-first one
   * usually does have a password by the time they come back.
   */
  const [useCode, setUseCode] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [step, setStep] = useState<Step>({ name: 'request' })
  const [value, setValue] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const configured = hasSupabaseConfig()

  /** The email tab defaults to a password; the phone tab has no password path. */
  const passwordMode = channel === 'email' && !useCode

  async function handleRequest(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (passwordMode) {
        // On success the SessionProvider swaps this page out.
        await signInWithPassword(value, password)
        return
      }
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

  async function handleResetRequest(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await requestPasswordReset(value)
      setStep({ name: 'reset-set', email: result.destination })
      setCode('')
      setPassword('')
    } catch (cause) {
      setError(messageFor(cause, t))
    } finally {
      setBusy(false)
    }
  }

  async function handleResetSet(event: React.FormEvent) {
    event.preventDefault()
    if (step.name !== 'reset-set') return
    setError(null)
    setBusy(true)
    try {
      await completePasswordReset({ email: step.email, code, password })
    } catch (cause) {
      setError(messageFor(cause, t))
    } finally {
      setBusy(false)
    }
  }

  function goToSignIn() {
    setStep({ name: 'request' })
    setError(null)
    setCode('')
    setPassword('')
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
          {step.name === 'reset-request' ? (
            <>
              <CardHeader>
                <CardTitle>{t('auth.resetTitle')}</CardTitle>
                <CardDescription>{t('auth.resetSubtitle')}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleResetRequest} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-email">{t('auth.emailLabel')}</Label>
                    <Input
                      id="reset-email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      required
                      placeholder={t('auth.emailPlaceholder')}
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      aria-invalid={error !== null}
                    />
                  </div>

                  {error && <ErrorText id="reset-error">{error}</ErrorText>}

                  <Button type="submit" disabled={busy || !configured} className="w-full">
                    {busy ? t('auth.sending') : t('auth.resetSendCode')}
                  </Button>
                  <Button type="button" variant="link" size="sm" onClick={goToSignIn}>
                    {t('auth.backToSignIn')}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : step.name === 'reset-set' ? (
            <>
              <CardHeader>
                <CardTitle>{t('auth.resetSetTitle')}</CardTitle>
                <CardDescription>
                  {t('auth.codeSentTo', { destination: step.email })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleResetSet} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-code">{t('auth.codeLabel')}</Label>
                    <Input
                      id="reset-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\\d{6}"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      className="text-center text-lg tracking-[0.4em]"
                    />
                  </div>

                  <PasswordField
                    id="reset-password"
                    label={t('auth.newPasswordLabel')}
                    value={password}
                    onChange={setPassword}
                    shown={showPassword}
                    onToggle={() => setShowPassword((on) => !on)}
                    autoComplete="new-password"
                    describedBy="reset-password-hint"
                    invalid={error !== null}
                  />
                  <p id="reset-password-hint" className="-mt-2 text-xs text-muted-foreground">
                    {t('auth.passwordTooShort', { count: MIN_PASSWORD_LENGTH })}
                  </p>

                  {error && <ErrorText id="reset-set-error">{error}</ErrorText>}

                  <Button type="submit" disabled={busy} className="w-full">
                    {busy ? t('auth.resetSaving') : t('auth.resetSave')}
                  </Button>
                  <Button type="button" variant="link" size="sm" onClick={goToSignIn}>
                    {t('auth.backToSignIn')}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : step.name === 'request' ? (
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

                  {passwordMode && (
                    <PasswordField
                      id="sign-in-password"
                      label={t('auth.passwordLabel')}
                      value={password}
                      onChange={setPassword}
                      shown={showPassword}
                      onToggle={() => setShowPassword((on) => !on)}
                      autoComplete="current-password"
                      invalid={error !== null}
                      {...(error === null ? {} : { describedBy: 'sign-in-error' })}
                    />
                  )}

                  {error && <ErrorText id="sign-in-error">{error}</ErrorText>}
                  {!configured && <ErrorText>{t('auth.unconfigured')}</ErrorText>}

                  <Button type="submit" disabled={busy || !configured} className="w-full">
                    {passwordMode
                      ? busy
                        ? t('auth.signingIn')
                        : t('auth.signIn')
                      : busy
                        ? t('auth.sending')
                        : t('auth.sendCode')}
                  </Button>

                  {channel === 'email' && (
                    <div className="flex flex-wrap items-center justify-between gap-x-4">
                      <button
                        type="button"
                        onClick={() => {
                          setUseCode((on) => !on)
                          setPassword('')
                          setError(null)
                        }}
                        className="min-h-11 text-sm font-medium text-primary hover:underline"
                      >
                        {passwordMode ? t('auth.useCodeInstead') : t('auth.usePasswordInstead')}
                      </button>
                      {passwordMode && (
                        <button
                          type="button"
                          onClick={() => {
                            setStep({ name: 'reset-request' })
                            setError(null)
                          }}
                          className="min-h-11 text-sm text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {t('auth.forgotPassword')}
                        </button>
                      )}
                    </div>
                  )}
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

/**
 * Password field with a reveal toggle.
 *
 * A seller typing a password on a phone keyboard, one-handed, with autocorrect
 * fighting them, gets it wrong often enough that hiding it by default and
 * offering no way to look is the actual usability problem — not shoulder
 * surfing. The button is 44px, sits inside the field, and is a real
 * `aria-pressed` control so a screen reader announces the state rather than
 * just the icon.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  shown,
  onToggle,
  autoComplete,
  describedBy,
  invalid,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  shown: boolean
  onToggle: () => void
  autoComplete: 'current-password' | 'new-password'
  describedBy?: string
  invalid?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name="password"
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="pr-12"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid === true}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={shown}
          aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')}
          className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
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
      case 'password':
        return cause.message
    }
  }

  /*
   * GoTrue answers a wrong password and an unknown email with the same
   * "Invalid login credentials", on purpose — telling a stranger which half was
   * right turns the sign-in form into a way to enumerate who has an account.
   * Reworded so a seller knows what to do next without us leaking which it was.
   */
  const message = errorMessage(cause).toLowerCase()
  if (message.includes('invalid login credentials')) return t('auth.passwordWrong')
  if (message.includes('signups not allowed') || message.includes('user not found')) {
    return t('auth.noAccountForEmail')
  }
  const raw = errorMessage(cause)
  return raw === '' ? t('errors.unexpected') : raw
}
