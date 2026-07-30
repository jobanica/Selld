import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileUp } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import type { Translate } from '@/lib/i18n'

import { saveProduct } from './catalog-api'
import {
  csvTemplate,
  groupCsvRows,
  importCatalogCsv,
  type CsvImportResult,
  type GroupedCsvProduct,
} from './csv'

/**
 * CSV import, with a preview before anything is written.
 *
 * The preview is the point. A seller importing two years of price list has no way
 * to know whether we understood her file, and finding out by inspecting 200 created
 * products is not a recovery path. So: parse, show what we found and what we could
 * not, and only write on confirmation.
 */
export function CsvImportPanel({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [parsed, setParsed] = useState<CsvImportResult | null>(null)
  const [grouped, setGrouped] = useState<GroupedCsvProduct[]>([])
  const [readError, setReadError] = useState<string | null>(null)

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setReadError(null)
    try {
      const text = await file.text()
      const result = importCatalogCsv(text)
      setParsed(result)
      setGrouped(groupCsvRows(result.rows))
    } catch (cause) {
      setReadError(describe(cause, t))
    }
  }

  const importMutation = useMutation({
    mutationFn: async () => {
      let created = 0
      for (const product of grouped) {
        await saveProduct(tenant.id, {
          name: product.name,
          description: product.description,
          status: product.status,
          categoryId: null,
          isCodAllowed: product.codAllowed,
          weightGrams: product.variants[0]?.weightGrams ?? null,
          options: product.optionNames.map((name, index) => ({
            name,
            values: [
              ...new Set(product.variants.map((variant) => variant.values[index] ?? '')),
            ]
              .filter((value) => value !== '')
              .map((value) => ({ value })),
          })),
          variants: product.variants.map((variant) => ({
            values: variant.values,
            sku: variant.sku,
            price: variant.price,
            compareAtPrice: variant.compareAtPrice,
            cost: variant.cost,
            weightGrams: variant.weightGrams,
          })),
        })
        created += 1
      }
      return created
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      onDone()
    },
  })

  const variantCount = grouped.reduce((total, product) => total + product.variants.length, 0)

  return (
    <Card>
      <CardHeader className="gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
          <FileUp className="size-5" aria-hidden="true" />
        </span>
        <CardTitle>{t('catalog.importTitle')}</CardTitle>
        <CardDescription>{t('catalog.emptyBody')}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            {t('catalog.importChoose')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => downloadTemplate(t('catalog.importTemplate'))}
          >
            {t('catalog.importTemplate')}
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={handleFile}
        />

        {readError && (
          <p role="alert" className="text-sm text-destructive">
            {readError}
          </p>
        )}

        {parsed && (
          <div className="flex flex-col gap-3">
            <p className="text-sm" data-testid="import-preview">
              {t('catalog.importPreview', {
                products: grouped.length,
                variants: variantCount,
              })}
            </p>

            {parsed.unknownColumns.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('catalog.importUnknownColumns', {
                  columns: parsed.unknownColumns.join(', '),
                })}
              </p>
            )}

            {parsed.errors.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="size-4" aria-hidden="true" />
                  {t('catalog.importErrors', { count: parsed.errors.length })}
                </p>
                {/* Show a bounded sample; a 200-error list is not readable on a phone. */}
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {parsed.errors.slice(0, 8).map((rowError, index) => (
                    <li key={index}>
                      Line {rowError.line}
                      {rowError.column ? ` · ${rowError.column}` : ''}: {rowError.message}
                    </li>
                  ))}
                  {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more.</li>}
                </ul>
              </div>
            )}

            {importMutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {describe(importMutation.error, t)}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                disabled={grouped.length === 0 || importMutation.isPending}
                onClick={() => importMutation.mutate()}
                data-testid="confirm-import"
              >
                {importMutation.isPending ? t('catalog.importing') : t('catalog.importConfirm')}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {!parsed && (
          <Button type="button" variant="ghost" onClick={onCancel} className="self-start">
            {t('common.cancel')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function downloadTemplate(filename: string): void {
  const blob = new Blob([`\ufeff${csvTemplate()}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filename.toLowerCase().replace(/\s+/g, '-')}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function describe(cause: unknown, t: Translate): string {
  return cause instanceof Error ? cause.message : t('errors.unexpected')
}
