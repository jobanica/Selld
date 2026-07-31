import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Filter, Upload, Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { getSupabase } from '@/lib/supabase/client'
import { formatPHP, fromDb } from '@/lib/money'
import { formatManilaDate } from '@/lib/time/manila'

import { CustomerPanel } from './customer-panel'
import {
  describeCustomerError,
  fetchCustomers,
  importCustomers,
  type ImportResult,
} from './customers-api'
import { SegmentBuilder } from './segment-builder'

/**
 * The customers screen.
 *
 * Three things, in the order a seller needs them: who bought from me, who is a
 * group worth messaging, and how do I get the people I already have into here.
 *
 * The list leads with money and the last order date rather than with a name and
 * an email, because the question in front of a seller looking at this screen is
 * never "what is this person called" — they know — it is "is this somebody I
 * should be chasing".
 */
export function CustomersPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const [openId, setOpenId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('recent')
  const [showSegments, setShowSegments] = useState(false)

  const customers = useQuery({
    queryKey: ['customers', tenant.id, search, sort],
    queryFn: () => fetchCustomers({ tenantId: tenant.id, search, sort }),
  })

  // Only the categories, and only for the segment builder's dropdown. A join in
  // the list query would cost every row a lookup nobody reads.
  const categories = useQuery({
    queryKey: ['categories', tenant.id],
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('categories')
        .select('id, name')
        .eq('tenant_id', tenant.id)
        .order('name')
      if (error) throw error
      return (data ?? []) as { id: string; name: string }[]
    },
  })

  if (openId !== null) {
    return <CustomerPanel customerId={openId} onClose={() => setOpenId(null)} />
  }

  const rows = customers.data?.customers ?? []

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-headline text-2xl font-bold tracking-tight">
            {t('customers.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('customers.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={showSegments}
          onClick={() => setShowSegments((open) => !open)}
        >
          <Filter className="mr-2 size-4" aria-hidden="true" />
          {t('customers.segmentsAction')}
        </Button>
      </header>

      {showSegments && (
        <div className="flex flex-col gap-6">
          <SegmentBuilder categories={categories.data ?? []} onOpenCustomer={setOpenId} />
          <ImportPanel />
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" aria-hidden="true" />
            {t('customers.listTitle', { count: customers.data?.total ?? 0 })}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="customer-search"
              value={search}
              placeholder={t('customers.searchPlaceholder')}
              aria-label={t('customers.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              aria-label={t('customers.sortLabel')}
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="recent">{t('customers.sortRecent')}</option>
              <option value="spend">{t('customers.sortSpend')}</option>
              <option value="orders">{t('customers.sortOrders')}</option>
              <option value="name">{t('customers.sortName')}</option>
            </select>
          </div>

          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('customers.empty')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {rows.map((customer) => (
                <li key={customer.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-col gap-1 py-3 text-left"
                    onClick={() => setOpenId(customer.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{customer.name}</span>
                      {customer.rts > 0 && (
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                          {t('customers.rtsBadge', { count: customer.rts })}
                        </span>
                      )}
                      {customer.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {tag.name}
                        </span>
                      ))}
                      <span className="ml-auto shrink-0 tabular-nums">
                        {formatPHP(fromDb(customer.spent))}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {customer.phone} · {t('customers.orderCount', { count: customer.orders })}
                      {customer.lastOrderAt === null
                        ? ` · ${t('customers.neverOrdered')}`
                        : ` · ${formatManilaDate(customer.lastOrderAt)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Import, with the confirmation shown *after* the write rather than before.
 *
 * A deliberate difference from the COD statement import, which drafts and then
 * posts. This is idempotent in a way that is not: a customer import upserts on
 * the phone number, so running it twice recognises everybody and creates nobody.
 * The thing that would be worth confirming — "these 397 are the people" —
 * cannot go wrong in a way a second click would fix, and the counts afterwards
 * say exactly what happened.
 */
function ImportPanel() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    result: ImportResult
    source: string
    columns: { name: string | null; phone: string | null }
    skipped: number
  } | null>(null)

  const run = useMutation({
    mutationFn: (file: File) =>
      importCustomers({ tenantId: tenant.id, file, tagName: t('customers.importTag') }),
    onSuccess: async ({ parsed, result: counts }) => {
      setError(null)
      setResult({
        result: counts,
        source: parsed.source,
        columns: { name: parsed.columns.name, phone: parsed.columns.phone },
        skipped: parsed.skipped.length,
      })
      await queryClient.invalidateQueries({ queryKey: ['customers', tenant.id] })
    },
    onError: (cause) => {
      setResult(null)
      setError(describeCustomerError(cause))
    },
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('customers.importTitle')}</CardTitle>
        <CardDescription>{t('customers.importSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Label htmlFor="customer-import" className="sr-only">
          {t('customers.importTitle')}
        </Label>
        {/* Hidden, and driven by the button below: a bare file input renders as a
            20px control that fails the 44px touch target the whole dashboard is
            built to. */}
        <input
          ref={fileInput}
          id="customer-import"
          type="file"
          accept=".csv,.xlsx,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) run.mutate(file)
          }}
        />

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:w-auto"
          disabled={run.isPending}
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="mr-2 size-4" aria-hidden="true" />
          {run.isPending ? t('customers.importing') : t('customers.importAction')}
        </Button>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {t(error as 'customers.errorUnknown')}
          </p>
        )}

        {result !== null && (
          <div className="rounded-lg bg-muted p-3 text-sm">
            <p>
              {t('customers.importResult', {
                created: result.result.created,
                updated: result.result.updated,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('customers.importRead', {
                source: result.source,
                name: result.columns.name ?? '—',
                phone: result.columns.phone ?? '—',
              })}
            </p>
            {(result.result.invalid > 0 || result.result.duplicatesInFile > 0) && (
              <p className="text-xs text-muted-foreground">
                {t('customers.importSkipped', {
                  invalid: result.result.invalid,
                  duplicates: result.result.duplicatesInFile,
                })}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
