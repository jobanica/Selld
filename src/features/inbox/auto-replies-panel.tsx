import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'

import {
  deleteAutoReply,
  describeInboxError,
  fetchAutoReplies,
  previewAutoReply,
  saveAutoReply,
} from './inbox-api'

/**
 * The keyword rules, and a box to try them in.
 *
 * The "try it" box is the important half. A rule is a small program the seller is
 * writing about their own customers, and the difference between `word` and
 * `contains` — between a rule for "cod" that answers a question and one that fires
 * on "codigo" — is invisible until you type a sentence and see what comes back.
 *
 * Matching happens in the database, not here, so what the box shows is what will
 * actually be sent rather than a second implementation that agrees today.
 */
export function AutoRepliesPanel() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [keyword, setKeyword] = useState('')
  const [body, setBody] = useState('')
  const [trial, setTrial] = useState('')
  const [error, setError] = useState<string | null>(null)

  const rules = useQuery({
    queryKey: ['auto-replies', tenant.id],
    queryFn: () => fetchAutoReplies(tenant.id),
  })

  const preview = useQuery({
    queryKey: ['auto-reply-preview', tenant.id, trial],
    queryFn: () => previewAutoReply({ tenantId: tenant.id, text: trial, channel: 'comment' }),
    enabled: trial.trim() !== '',
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['auto-replies', tenant.id] })
    await queryClient.invalidateQueries({ queryKey: ['auto-reply-preview', tenant.id] })
  }

  const add = useMutation({
    mutationFn: () =>
      saveAutoReply({
        tenantId: tenant.id,
        id: null,
        keyword,
        body,
        channel: 'both',
        matchType: 'word',
        isActive: true,
        priority: 0,
      }),
    onSuccess: async () => {
      setKeyword('')
      setBody('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeInboxError(cause)),
  })

  const toggle = useMutation({
    mutationFn: (rule: { id: string; keyword: string; body: string; isActive: boolean }) =>
      saveAutoReply({
        tenantId: tenant.id,
        id: rule.id,
        keyword: rule.keyword,
        body: rule.body,
        channel: 'both',
        matchType: 'word',
        isActive: !rule.isActive,
        priority: 0,
      }),
    onSuccess: invalidate,
    onError: (cause) => setError(describeInboxError(cause)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteAutoReply(id),
    onSuccess: invalidate,
    onError: (cause) => setError(describeInboxError(cause)),
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('inbox.rulesTitle')}</CardTitle>
        <CardDescription>{t('inbox.rulesSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y">
          {(rules.data ?? []).map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 py-3">
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                {rule.keyword}
              </span>
              <span className={`flex-1 text-sm ${rule.is_active ? '' : 'text-muted-foreground line-through'}`}>
                {rule.body}
              </span>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() =>
                  toggle.mutate({
                    id: rule.id,
                    keyword: rule.keyword,
                    body: rule.body,
                    isActive: rule.is_active,
                  })
                }
              >
                {rule.is_active ? t('inbox.ruleOff') : t('inbox.ruleOn')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 px-3"
                aria-label={t('inbox.ruleDelete')}
                onClick={() => remove.mutate(rule.id)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-keyword">{t('inbox.ruleKeywordLabel')}</Label>
            <Input
              id="rule-keyword"
              value={keyword}
              placeholder={t('inbox.ruleKeywordPlaceholder')}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-body">{t('inbox.ruleBodyLabel')}</Label>
            <Input
              id="rule-body"
              value={body}
              placeholder={t('inbox.ruleBodyPlaceholder')}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('inbox.ruleBodyHint')}</p>
          </div>
          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={keyword.trim() === '' || body.trim() === '' || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {t('inbox.ruleAddAction')}
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-trial">{t('inbox.tryLabel')}</Label>
          <Input
            id="rule-trial"
            value={trial}
            placeholder={t('inbox.tryPlaceholder')}
            onChange={(event) => setTrial(event.target.value)}
          />
          {trial.trim() !== '' && (
            <p className="rounded-lg bg-muted p-3 text-sm">
              {preview.data == null
                ? t('inbox.tryNoMatch')
                : `${preview.data.keyword} → ${preview.data.body}`}
            </p>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'inbox.errorUnknown')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
