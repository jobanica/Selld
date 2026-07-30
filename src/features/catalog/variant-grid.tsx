import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { centavos, formatPHP, parsePesos, toPesoInputValue, type Centavos } from '@/lib/money'

import { buildSku, combinationLabel, type DraftVariant } from './variant-matrix'

/**
 * Inline editor for a generated variant matrix.
 *
 * This is where the 2-minute target is won or lost. Twelve rows × three fields is
 * 36 taps if each one is a separate form field, so the design leans on two bulk
 * actions — "apply this price to all" and "auto-fill SKUs" — which take the common
 * case (one price across a size run) from twelve entries to one.
 *
 * Layout is a card list on phones and a table from `sm` up. A real table at 390px
 * either overflows horizontally or shrinks the inputs below a tappable size; both
 * are worse than stacking.
 *
 * Stock is deliberately absent. `inventory_levels` is per-location and arrives in
 * phase 4, so a stock column here would be a second source of truth on day one.
 */
export function VariantGrid({
  variants,
  onChange,
  skuPrefix,
  onSkuPrefixChange,
}: {
  variants: DraftVariant[]
  onChange: (next: DraftVariant[]) => void
  skuPrefix: string
  onSkuPrefixChange: (next: string) => void
}) {
  const { t } = useTranslation()

  const update = (index: number, patch: Partial<DraftVariant>) => {
    onChange(variants.map((variant, at) => (at === index ? { ...variant, ...patch } : variant)))
  }

  const applyPriceToAll = (raw: string) => {
    const price = parsePesos(raw === '' ? '0' : raw)
    if (price === null) return
    onChange(variants.map((variant) => ({ ...variant, price })))
  }

  const autoFillSkus = () => {
    if (skuPrefix.trim() === '') return
    onChange(
      variants.map((variant, index) => ({
        ...variant,
        sku: buildSku(skuPrefix, variant.values, index),
      })),
    )
  }

  if (variants.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {/* Bulk actions first: on a phone they are the difference between one entry
          and twelve, so they must not be below the fold of the grid. */}
      <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="bulk-price" className="text-xs">
            {t('catalog.applyToAll')}
          </Label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
            >
              ₱
            </span>
            <Input
              id="bulk-price"
              inputMode="decimal"
              className="pl-7"
              placeholder={t('catalog.bulkPricePlaceholder')}
              onChange={(event) => applyPriceToAll(event.target.value)}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="sku-prefix" className="text-xs">
            {t('catalog.generateSkus')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="sku-prefix"
              className="min-w-0 flex-1"
              placeholder={t('catalog.skuPrefixPlaceholder')}
              value={skuPrefix}
              onChange={(event) => onSkuPrefixChange(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              onClick={autoFillSkus}
              disabled={skuPrefix.trim() === ''}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('catalog.variantsGenerated', { count: variants.length })} ·{' '}
        {t('catalog.stockComingSoon')}
      </p>

      {/* Table from sm up. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-2 font-medium">{t('catalog.variantHeaderVariant')}</th>
              <th className="py-2 pr-2 font-medium">{t('catalog.variantHeaderSku')}</th>
              <th className="py-2 pr-2 font-medium">{t('catalog.variantHeaderPrice')}</th>
              <th className="py-2 font-medium">{t('catalog.variantHeaderCost')}</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant, index) => (
              <tr key={variant.values.join('|') || 'default'} className="border-b last:border-0">
                <td className="py-1.5 pr-2 font-medium">
                  {combinationLabel(variant.values) || '—'}
                </td>
                <td className="py-1.5 pr-2">
                  <Input
                    aria-label={`SKU ${combinationLabel(variant.values)}`}
                    className="h-9 min-w-[7rem]"
                    value={variant.sku}
                    onChange={(event) => update(index, { sku: event.target.value })}
                  />
                </td>
                <td className="py-1.5 pr-2">
                  <MoneyInput
                    label={`Price ${combinationLabel(variant.values)}`}
                    value={variant.price}
                    onChange={(price) => update(index, { price: price ?? centavos(0) })}
                  />
                </td>
                <td className="py-1.5">
                  <MoneyInput
                    label={`Cost ${combinationLabel(variant.values)}`}
                    value={variant.cost}
                    nullable
                    onChange={(cost) => update(index, { cost })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Stacked cards on phones. */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {variants.map((variant, index) => (
          <li
            key={variant.values.join('|') || 'default'}
            className="flex flex-col gap-2 rounded-md border p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{combinationLabel(variant.values) || '—'}</span>
              <span className="text-xs tabular text-muted-foreground">
                {formatPHP(variant.price)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('catalog.variantHeaderPrice')}</Label>
                <MoneyInput
                  label={`Price ${combinationLabel(variant.values)}`}
                  value={variant.price}
                  onChange={(price) => update(index, { price: price ?? centavos(0) })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('catalog.variantHeaderSku')}</Label>
                <Input
                  aria-label={`SKU ${combinationLabel(variant.values)}`}
                  value={variant.sku}
                  onChange={(event) => update(index, { sku: event.target.value })}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Peso input that keeps its own text while the seller types, but still reflects an
 * external change.
 *
 * Both halves matter. Reformatting on every keystroke fights the seller — typing
 * "1499" through a formatter that rewrites mid-entry gives "14.99" — so the raw
 * text is what gets edited. But a plain `defaultValue` makes the field
 * uncontrolled, and then "apply this price to all" updates the row badge while
 * leaving twelve inputs showing the old number. It saves correctly and looks
 * broken, which is arguably worse than being broken.
 *
 * So: local text for typing, resynced when the incoming value changes. The
 * comparison happens during render (React's documented way to adjust state from
 * props) rather than in an effect, which the react-hooks rules reject.
 */
function MoneyInput({
  label,
  value,
  onChange,
  nullable = false,
}: {
  label: string
  value: Centavos | null
  onChange: (next: Centavos | null) => void
  nullable?: boolean
}) {
  const asText = (next: Centavos | null) => (next === null ? '' : toPesoInputValue(next))

  const [text, setText] = useState(() => asText(value))
  const [lastExternal, setLastExternal] = useState(value)

  if (value !== lastExternal) {
    setLastExternal(value)
    setText(asText(value))
  }

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
      >
        ₱
      </span>
      <Input
        aria-label={label}
        inputMode="decimal"
        className="h-9 min-w-[6rem] pl-6 tabular"
        value={text}
        onChange={(event) => {
          const raw = event.target.value
          setText(raw)

          if (raw.trim() === '') {
            const next = nullable ? null : (0 as Centavos)
            setLastExternal(next)
            onChange(next)
            return
          }

          const parsed = parsePesos(raw)
          // Ignore unparseable intermediate states ("1.", "-") rather than
          // clobbering what the seller is still typing.
          if (parsed !== null) {
            setLastExternal(parsed)
            onChange(parsed)
          }
        }}
      />
    </div>
  )
}
