import { useMutation } from '@tanstack/react-query'
import { CheckCircle2, Mail } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SignInPage } from '@/features/auth/sign-in-page'
import { useSession } from '@/features/auth/use-session'
import type { Translate } from '@/lib/i18n'
import { acceptInvitation } from '@/features/tenancy/tenancy-api'
import { useTenant } from '@/features/tenancy/use-tenant'

/**
 * Redeem an invitation token from `/invite/:token`.
 *
 * The invitee must sign in first: `accept_invitation()` checks the token was
 * issued to *their* email, so a forwarded link cannot be redeemed by whoever
 * happens to open it. Signing in before accepting is what makes that check
 * possible, rather than an inconvenience we could skip.
 */
export function AcceptInvitationPage() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const { status } = useSession()
  const { refetch, setActiveTenant } = useTenant()

  const mutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Missing invitation token')
      return acceptInvitation(token)
    },
    onSuccess: async (result) => {
      setActiveTenant(result.tenantId)
      await refetch()
    },
  })

  if (status === 'loading') return null
  if (status === 'anonymous' || status === 'unconfigured') return <SignInPage />

  return (
    <div className="flex min-h-dvh items-start justify-center bg-muted/30 px-4 py-8 sm:items-center">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            {mutation.isSuccess ? (
              <CheckCircle2 className="size-5" aria-hidden="true" />
            ) : (
              <Mail className="size-5" aria-hidden="true" />
            )}
          </span>
          <CardTitle>{t('invite.title')}</CardTitle>
          <CardDescription>
            {mutation.isSuccess ? t('invite.accepted') : t('invite.body')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {describe(mutation.error, t)}
            </p>
          )}

          {mutation.isSuccess ? (
            <Button asChild className="w-full">
              <Link to="/">{t('errors.backToDashboard')}</Link>
            </Button>
          ) : (
            <Button
              className="w-full"
              disabled={mutation.isPending || !token}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? t('invite.accepting') : t('invite.accept')}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function describe(cause: unknown, t: Translate): string {
  if (!(cause instanceof Error)) return t('errors.unexpected')
  const message = cause.message.toLowerCase()
  if (message.includes('different email')) return t('invite.wrongEmail')
  if (message.includes('expired')) return t('invite.expired')
  if (message.includes('already accepted')) return t('invite.alreadyAccepted')
  if (message.includes('not found')) return t('invite.notFound')
  return cause.message
}
