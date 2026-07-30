import { useQuery } from '@tanstack/react-query'
import { Boxes, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { cn } from '@/lib/utils'

import { fetchInventory, type InventoryRow } from './inventory-api'
import { StockAdjustSheet } from './stock-adjust-sheet'

/**
 * Inventory screen.
 *
 * Leads with `available`, not `on_hand`. On hand is what is in the room; available
 * is what a buyer can actually buy, and it is the number that decides whether the
 * next order can be taken. Showing on-hand first is how a seller oversells while
 * looking at a screen that says she has stock.
 */
export function InventoryPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()

  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null)

  const inventory = useQuery({
    queryKey: ['inventory', tenant.id, search, lowOnly],
    queryFn: () => fetchInventory(tenant.id, { search, lowOnly }),
  })

  const rows = inventory.data ?? []
  const lowCount = rows.filter((row) => row.isLow).length

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('inventory.title')}</h1>
      </header>

      {lowCount > 0 && !lowOnly && (
        <button
          type="button"
          onClick={() => setLowOnly(true)}
          className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-left text-sm"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          {t('inventory.lowStockCount', { count: lowCount })}
        </button>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="sm:max-w-xs"
          placeholder={t('inventory.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex gap-1">
          {[
            { key: false, label: t('inventory.all') },
            { key: true, label: t('inventory.lowOnly') },
          ].map((option) => (
            <button
              key={String(option.key)}
              type="button"
              aria-pressed={lowOnly === option.key}
              onClick={() => setLowOnly(option.key)}
              className={cn(
                'min-h-9 shrink-0 rounded-md px-3 text-sm transition-colors',
                lowOnly === option.key
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {inventory.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader className="items-start gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Boxes className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base">{t('inventory.empty')}</CardTitle>
            <CardDescription>{t('inventory.emptyBody')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {/* Table from sm up. */}
          <Card className="hidden overflow-x-auto sm:block">
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-3 font-medium">{t('inventory.headerProduct')}</th>
                    <th className="p-3 text-right font-medium">{t('inventory.headerOnHand')}</th>
                    <th className="p-3 text-right font-medium">{t('inventory.headerReserved')}</th>
                    <th className="p-3 text-right font-medium">{t('inventory.headerAvailable')}</th>
                  </tr>
                </thead>
                <tbody data-testid="inventory-table">
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      role="button"
                      onClick={() => setAdjusting(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setAdjusting(row)
                      }}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent"
                    >
                      <td className="p-3">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{row.productName}</span>
                          {row.isLow && <LowBadge />}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {row.sku ?? '—'} · {row.locationName}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular">{row.onHand}</td>
                      <td className="p-3 text-right tabular text-muted-foreground">
                        {row.reserved}
                      </td>
                      <td
                        className={cn(
                          'p-3 text-right font-semibold tabular',
                          row.available === 0 && 'text-destructive',
                        )}
                      >
                        {row.available}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Cards on phones, available first. */}
          <ul className="flex flex-col gap-2 sm:hidden" data-testid="inventory-list">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setAdjusting(row)}
                  className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{row.productName}</span>
                      {row.isLow && <LowBadge />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {row.sku ?? '—'} · {t('inventory.onHand')} {row.onHand} ·{' '}
                      {t('inventory.reserved')} {row.reserved}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span
                      className={cn(
                        'block text-lg font-semibold tabular',
                        row.available === 0 && 'text-destructive',
                      )}
                    >
                      {row.available}
                    </span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('inventory.available')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {adjusting && <StockAdjustSheet row={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  )
}

function LowBadge() {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
      {t('inventory.lowBadge')}
    </span>
  )
}
