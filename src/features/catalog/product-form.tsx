import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { describePlanLimitError } from '@/features/billing/billing-api'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import type { Translate } from '@/lib/i18n'
import { centavos, parsePesos, type Centavos } from '@/lib/money'
import { errorMessage } from '@/lib/supabase/errors'

import { fetchCategories, fetchProduct, saveProduct, type ProductStatus } from './catalog-api'
import { VariantGrid } from './variant-grid'
import {
  countCombinations,
  generateVariantMatrix,
  MAX_VARIANTS,
  VariantMatrixError,
  type DraftOption,
  type DraftVariant,
} from './variant-matrix'

/**
 * Quick-add / edit form for a product.
 *
 * Optimised for one-handed phone entry: name and price first (which is all a
 * simple product needs), options collapsed until asked for, and comma-separated
 * value entry rather than a row of inputs per value — typing `S, M, L` into one
 * field is three taps, not three fields.
 */
export function ProductForm({
  productId,
  onDone,
  onCancel,
}: {
  productId?: string
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const existing = useQuery({
    queryKey: ['product', productId],
    queryFn: () => fetchProduct(productId ?? ''),
    enabled: productId !== undefined,
  })

  const categories = useQuery({
    queryKey: ['categories', tenant.id],
    queryFn: () => fetchCategories(tenant.id),
  })

  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [isCodAllowed, setIsCodAllowed] = useState(true)
  const [weight, setWeight] = useState('')
  const [basePrice, setBasePrice] = useState('')
  const [skuPrefix, setSkuPrefix] = useState('')
  const [optionDrafts, setOptionDrafts] = useState<{ name: string; values: string }[]>([])
  const [variants, setVariants] = useState<DraftVariant[]>([])
  const [error, setError] = useState<string | null>(null)

  // Hydrate from the loaded product exactly once. Driven by comparing ids rather
  // than by an effect, which the react-hooks rules rightly reject.
  if (existing.data && loadedId !== existing.data.id) {
    const product = existing.data
    setLoadedId(product.id)
    setName(product.name)
    setDescription(product.description)
    setCategoryId(product.categoryId)
    setIsCodAllowed(product.isCodAllowed)
    setWeight(product.weightGrams === null ? '' : String(product.weightGrams))
    setOptionDrafts(
      product.options.map((option) => ({
        name: option.name,
        values: option.values.map((value) => value.value).join(', '),
      })),
    )
    setVariants(product.variants)
  }

  const options = useMemo<DraftOption[]>(
    () =>
      optionDrafts
        .map((draft) => ({
          name: draft.name,
          values: draft.values
            .split(',')
            .map((value) => ({ value: value.trim() }))
            .filter((value) => value.value !== ''),
        }))
        .filter((option) => option.name.trim() !== '' && option.values.length > 0),
    [optionDrafts],
  )

  const projectedCount = useMemo(() => {
    try {
      return countCombinations(options)
    } catch {
      return 0
    }
  }, [options])

  /** Regenerate, keeping every price and SKU already typed for combinations that survive. */
  const regenerate = (nextOptions: DraftOption[]) => {
    setError(null)
    try {
      const parsedBase = parsePesos(basePrice === '' ? '0' : basePrice)
      const next = generateVariantMatrix(nextOptions, {
        defaultPrice: parsedBase ?? centavos(0),
        existing: variants,
        ...(skuPrefix.trim() === '' ? {} : { skuPrefix: skuPrefix.trim() }),
      })
      setVariants(next)
    } catch (cause) {
      setError(describe(cause, t))
    }
  }

  const setOption = (index: number, patch: Partial<{ name: string; values: string }>) => {
    const next = optionDrafts.map((draft, at) => (at === index ? { ...draft, ...patch } : draft))
    setOptionDrafts(next)
    regenerate(toOptions(next))
  }

  const addOption = () => {
    if (optionDrafts.length >= 3) return
    setOptionDrafts([...optionDrafts, { name: '', values: '' }])
  }

  const removeOption = (index: number) => {
    const next = optionDrafts.filter((_, at) => at !== index)
    setOptionDrafts(next)
    regenerate(toOptions(next))
  }

  const mutation = useMutation({
    mutationFn: async (status: ProductStatus) => {
      const parsedBase = parsePesos(basePrice === '' ? '0' : basePrice) ?? centavos(0)
      // A product with no options still needs exactly one variant to be sellable.
      const finalVariants =
        options.length === 0
          ? [
              variants[0] ?? {
                values: [],
                sku: skuPrefix.trim(),
                price: parsedBase,
                compareAtPrice: null,
                cost: null,
                weightGrams: null,
              },
            ]
          : variants

      const weightGrams = weight.trim() === '' ? null : Number(weight)

      return saveProduct(tenant.id, {
        ...(productId === undefined ? {} : { id: productId }),
        name,
        description,
        status,
        categoryId,
        isCodAllowed,
        weightGrams: Number.isInteger(weightGrams) ? weightGrams : null,
        options,
        variants: finalVariants,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      onDone()
    },
    onError: (cause) => setError(describe(cause, t)),
  })

  const canSave = name.trim() !== '' && !mutation.isPending

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate('active')
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-name">{t('catalog.nameLabel')}</Label>
        <Input
          id="product-name"
          required
          maxLength={200}
          autoFocus
          placeholder={t('catalog.namePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-price">{t('catalog.priceLabel')}</Label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
            >
              ₱
            </span>
            <Input
              id="product-price"
              inputMode="decimal"
              className="pl-7"
              placeholder="149"
              value={basePrice}
              onChange={(event) => {
                setBasePrice(event.target.value)
                const parsed = parsePesos(event.target.value || '0')
                // Keep single-variant products in sync with the headline price.
                if (parsed !== null && options.length === 0) {
                  setVariants((current) =>
                    current.length === 0
                      ? current
                      : current.map((variant) => ({ ...variant, price: parsed })),
                  )
                }
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-weight">{t('catalog.weightLabel')}</Label>
          <Input
            id="product-weight"
            inputMode="numeric"
            placeholder="150"
            value={weight}
            onChange={(event) => setWeight(event.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t('catalog.weightHint')}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-category">{t('catalog.categoryLabel')}</Label>
        <Select
          id="product-category"
          value={categoryId ?? ''}
          onChange={(event) => setCategoryId(event.target.value || null)}
        >
          <option value="">{t('catalog.categoryNone')}</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-description">{t('catalog.descriptionLabel')}</Label>
        <textarea
          id="product-description"
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-sm"
          placeholder={t('catalog.descriptionPlaceholder')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-[var(--color-primary)]"
          checked={isCodAllowed}
          onChange={(event) => setIsCodAllowed(event.target.checked)}
        />
        {t('catalog.codAllowedLabel')}
      </label>

      {/* Options */}
      <fieldset className="flex flex-col gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t('catalog.optionsTitle')}</legend>
        <p className="text-xs text-muted-foreground">{t('catalog.optionsHint')}</p>

        {optionDrafts.map((draft, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md bg-muted/50 p-2">
            <div className="flex gap-2">
              <Input
                aria-label={`${t('catalog.optionNameLabel')} ${index + 1}`}
                className="min-w-0 flex-1"
                placeholder={t('catalog.optionNamePlaceholder')}
                value={draft.name}
                onChange={(event) => setOption(index, { name: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('catalog.removeOption')}
                onClick={() => removeOption(index)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <Input
              aria-label={`${t('catalog.optionValuesLabel')} ${index + 1}`}
              placeholder={t('catalog.optionValuesPlaceholder')}
              value={draft.values}
              onChange={(event) => setOption(index, { values: event.target.value })}
            />
          </div>
        ))}

        {optionDrafts.length < 3 && (
          <Button type="button" variant="outline" onClick={addOption} className="self-start">
            <Plus aria-hidden="true" />
            {t('catalog.addOption')}
          </Button>
        )}

        {projectedCount > MAX_VARIANTS && (
          <p role="alert" className="text-sm text-destructive">
            {t('catalog.tooManyVariants')}
          </p>
        )}
      </fieldset>

      {variants.length > 1 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('catalog.variantsTitle')}</h3>
          <VariantGrid
            variants={variants}
            onChange={setVariants}
            skuPrefix={skuPrefix}
            onSkuPrefixChange={setSkuPrefix}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={!canSave} data-testid="save-publish">
          {mutation.isPending ? t('catalog.saving') : t('catalog.saveAndPublish')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canSave}
          onClick={() => mutation.mutate('draft')}
        >
          {t('catalog.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

function toOptions(drafts: readonly { name: string; values: string }[]): DraftOption[] {
  return drafts
    .map((draft) => ({
      name: draft.name,
      values: draft.values
        .split(',')
        .map((value) => ({ value: value.trim() }))
        .filter((value) => value.value !== ''),
    }))
    .filter((option) => option.name.trim() !== '' && option.values.length > 0)
}

function describe(cause: unknown, t: Translate): string {
  if (cause instanceof VariantMatrixError) {
    return cause.reason === 'too_many'
      ? t('catalog.tooManyVariants')
      : cause.reason === 'duplicate_option'
        ? t('catalog.duplicateOption')
        : cause.message
  }
  // Phase 19: the product ceiling is a trigger, so it rejects *here*, on the form
  // the seller is looking at. Without this the plan limit arrives as a plain
  // PostgREST object, fails the `instanceof Error` test below, and reads as
  // "Something went wrong" — which sends the seller to look for a bug in the
  // product form rather than at their plan.
  const planLimit = describePlanLimitError(cause)
  if (planLimit !== null) return t(planLimit as 'billing.limitProducts')

  if (cause instanceof Error) return cause.message
  const message = errorMessage(cause)
  return message === '' ? t('errors.unexpected') : message
}

/** Re-exported for the grid's price sync, which needs the branded type. */
export type { Centavos }
