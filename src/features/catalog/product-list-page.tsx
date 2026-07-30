import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Package, Plus, Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { categoriesForPresets } from '@/features/onboarding/category-presets'
import { publicAssetUrl } from '@/features/onboarding/onboarding-api'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP } from '@/lib/money'
import { fetchSettings } from '@/lib/settings'
import { formatManilaDate } from '@/lib/time/manila'
import { cn } from '@/lib/utils'

import {
  fetchCatalogForExport,
  fetchProducts,
  seedCategoriesFromPresets,
  type ProductStatus,
} from './catalog-api'
import { CsvImportPanel } from './csv-import-panel'
import { exportCatalogCsv, type ExportableVariant } from './csv'
import { ProductForm } from './product-form'

type StatusFilter = ProductStatus | 'all'

/** Products screen: list, search, status filter, quick-add, CSV import/export. */
export function ProductListPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [mode, setMode] = useState<'list' | 'new' | 'import'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)

  const products = useQuery({
    queryKey: ['products', tenant.id, search, status],
    queryFn: () => fetchProducts(tenant.id, { search, status }),
  })

  /**
   * Turn the onboarding preset choices into real categories the first time the
   * catalog is opened. Deliberately here rather than in the wizard: the wizard's
   * job is to get the seller to a live store fast, and this is only needed once she
   * actually reaches for a category.
   */
  useQuery({
    queryKey: ['seed-categories', tenant.id],
    queryFn: async () => {
      const settings = await fetchSettings(tenant.id)
      const names = categoriesForPresets(settings['catalog.presets'])
      if (names.length === 0) return 0
      const created = await seedCategoriesFromPresets(tenant.id, names)
      if (created > 0) {
        await queryClient.invalidateQueries({ queryKey: ['categories', tenant.id] })
      }
      return created
    },
    staleTime: Number.POSITIVE_INFINITY,
  })

  const exportMutation = useMutation({
    mutationFn: async () => {
      const details = await fetchCatalogForExport(tenant.id)
      const rows: ExportableVariant[] = details.flatMap((product) =>
        product.variants.map((variant) => ({
          productName: product.name,
          description: product.description,
          category: null,
          status: product.status,
          codAllowed: product.isCodAllowed,
          options: product.options.map((option, index) => ({
            name: option.name,
            value: variant.values[index] ?? '',
          })),
          sku: variant.sku,
          barcode: null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          cost: variant.cost,
          weightGrams: variant.weightGrams,
        })),
      )
      downloadCsv(`${tenant.slug}-catalog.csv`, exportCatalogCsv(rows))
    },
  })

  if (mode === 'new' || editingId !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? t('common.save') : t('catalog.addProduct')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductForm
              {...(editingId === null ? {} : { productId: editingId })}
              onDone={() => {
                setMode('list')
                setEditingId(null)
              }}
              onCancel={() => {
                setMode('list')
                setEditingId(null)
              }}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (mode === 'import') {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <CsvImportPanel onDone={() => setMode('list')} onCancel={() => setMode('list')} />
      </div>
    )
  }

  const items = products.data ?? []

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('catalog.title')}</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode('import')}>
            <Upload aria-hidden="true" />
            <span className="hidden sm:inline">{t('catalog.importTitle')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={exportMutation.isPending || items.length === 0}
            onClick={() => exportMutation.mutate()}
          >
            <Download aria-hidden="true" />
            <span className="hidden sm:inline">{t('catalog.exportCsv')}</span>
          </Button>
          <Button size="sm" onClick={() => setMode('new')} data-testid="add-product">
            <Plus aria-hidden="true" />
            {t('catalog.addProduct')}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="sm:max-w-xs"
          placeholder={t('catalog.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex gap-1 overflow-x-auto">
          {(['all', 'active', 'draft', 'archived'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={status === option}
              onClick={() => setStatus(option)}
              className={cn(
                'min-h-9 shrink-0 rounded-md px-3 text-sm transition-colors',
                status === option
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`catalog.filter${option[0]!.toUpperCase()}${option.slice(1)}` as 'catalog.filterAll')}
            </button>
          ))}
        </div>
      </div>

      {products.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <Card>
          <CardHeader className="items-start gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Package className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base">{t('catalog.empty')}</CardTitle>
            <CardDescription>{t('catalog.emptyBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setMode('new')}>
              <Plus aria-hidden="true" />
              {t('catalog.addProduct')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="product-list">
          {items.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => setEditingId(product.id)}
                className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
                  {product.imagePath ? (
                    <img
                      src={publicAssetUrl(product.imagePath) ?? ''}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <Package className="size-5 text-muted-foreground" aria-hidden="true" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{product.name}</span>
                    <StatusBadge status={product.status} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {t('catalog.variantCount', { count: product.variantCount })}
                    {product.categoryName ? ` · ${product.categoryName}` : ''} ·{' '}
                    {formatManilaDate(product.updatedAt)}
                  </span>
                </span>

                <span className="shrink-0 text-right text-sm tabular">
                  {product.minPrice === product.maxPrice
                    ? formatPHP(product.minPrice)
                    : `${formatPHP(product.minPrice)}+`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: ProductStatus }) {
  const { t } = useTranslation()
  const label =
    status === 'active'
      ? t('catalog.statusActive')
      : status === 'draft'
        ? t('catalog.statusDraft')
        : t('catalog.statusArchived')

  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        status === 'active'
          ? 'bg-primary/10 text-primary'
          : status === 'draft'
            ? 'bg-muted text-muted-foreground'
            : 'bg-destructive/10 text-destructive',
      )}
    >
      {label}
    </span>
  )
}

/** Trigger a client-side download without a server round trip. */
function downloadCsv(filename: string, content: string): void {
  // BOM so Excel opens UTF-8 correctly — without it, ñ and ₱ arrive mangled.
  const blob = new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
