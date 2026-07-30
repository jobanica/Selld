import { fromDb, type Centavos } from '@/lib/money'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'

import { diffVariants, type DraftOption, type DraftVariant } from './variant-matrix'

/**
 * Catalog reads and writes.
 *
 * No client-side `tenant_id` filtering anywhere: RLS decides what is visible, and
 * a `.eq('tenant_id', …)` the client could forget is not a security boundary.
 * `tenant_id` IS passed on writes, because the column is `not null` — and the
 * composite foreign keys make a mismatched value unrepresentable.
 */

export type ProductStatus = 'draft' | 'active' | 'archived'

export interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  sortOrder: number
}

export interface ProductListItem {
  id: string
  name: string
  slug: string
  status: ProductStatus
  categoryName: string | null
  variantCount: number
  /** Cheapest variant, for the "from ₱x" list price. */
  minPrice: Centavos
  maxPrice: Centavos
  imagePath: string | null
  updatedAt: string
}

export interface ProductDetail {
  id: string
  name: string
  slug: string
  description: string
  status: ProductStatus
  categoryId: string | null
  isCodAllowed: boolean
  weightGrams: number | null
  options: DraftOption[]
  variants: DraftVariant[]
  images: { id: string; storagePath: string; alt: string | null; sortOrder: number }[]
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function fetchCategories(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<Category[]> {
  const { data, error } = await client
    .from('categories')
    .select('id, name, slug, parent_id, sort_order')
    .eq('tenant_id', tenantId)
    .order('sort_order')
    .order('name')

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
  }))
}

/**
 * Turn the onboarding preset choices into real categories.
 *
 * Idempotent in the database, so calling it whenever the catalog is first opened
 * is safe — it creates only what is missing and returns the count.
 */
export async function seedCategoriesFromPresets(
  tenantId: string,
  names: readonly string[],
  client: SelldClient = getSupabase(),
): Promise<number> {
  if (names.length === 0) return 0
  const { data, error } = await client.rpc('seed_categories_from_presets', {
    p_tenant_id: tenantId,
    p_names: [...names],
  })
  if (error) throw error
  return data ?? 0
}

export async function createCategory(
  tenantId: string,
  name: string,
  client: SelldClient = getSupabase(),
): Promise<Category> {
  const { data, error } = await client
    .from('categories')
    .insert({ tenant_id: tenantId, name: name.trim(), slug: slugForCatalog(name) })
    .select('id, name, slug, parent_id, sort_order')
    .single()

  if (error) throw error
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    parentId: data.parent_id,
    sortOrder: data.sort_order,
  }
}

/** Mirrors `public.catalog_slugify`. The database is still the authority. */
export function slugForCatalog(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function fetchProducts(
  tenantId: string,
  options: { search?: string; status?: ProductStatus | 'all' } = {},
  client: SelldClient = getSupabase(),
): Promise<ProductListItem[]> {
  let request = client
    .from('products')
    .select(
      `id, name, slug, status, updated_at,
       categories(name),
       product_variants(price_centavos),
       product_images(storage_path, sort_order)`,
    )
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })

  if (options.status && options.status !== 'all') {
    request = request.eq('status', options.status)
  }
  if (options.search && options.search.trim() !== '') {
    request = request.ilike('name', `%${options.search.trim()}%`)
  }

  const { data, error } = await request
  if (error) throw error

  return (data ?? []).map((row) => {
    const variants = (row.product_variants ?? []) as { price_centavos: number | string }[]
    const prices = variants.map((variant) => fromDb(variant.price_centavos))
    const images = ((row.product_images ?? []) as { storage_path: string; sort_order: number }[])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
    const category = row.categories as { name: string } | null

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as ProductStatus,
      categoryName: category?.name ?? null,
      variantCount: variants.length,
      minPrice: (prices.length > 0 ? Math.min(...prices) : 0) as Centavos,
      maxPrice: (prices.length > 0 ? Math.max(...prices) : 0) as Centavos,
      imagePath: images[0]?.storage_path ?? null,
      updatedAt: row.updated_at,
    }
  })
}

export async function fetchProduct(
  productId: string,
  client: SelldClient = getSupabase(),
): Promise<ProductDetail | null> {
  const { data, error } = await client
    .from('products')
    .select(
      `id, name, slug, description, status, category_id, is_cod_allowed, weight_grams,
       product_options(id, name, sort_order, product_option_values(id, value, sort_order)),
       product_variants(id, sku, barcode, price_centavos, compare_at_price_centavos, cost_centavos, weight_grams, option_value_ids, position),
       product_images(id, storage_path, alt, sort_order)`,
    )
    .eq('id', productId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  type RawOption = {
    id: string
    name: string
    sort_order: number
    product_option_values: { id: string; value: string; sort_order: number }[] | null
  }

  const options: DraftOption[] = ((data.product_options ?? []) as RawOption[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => ({
      id: option.id,
      name: option.name,
      values: (option.product_option_values ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((value) => ({ id: value.id, value: value.value })),
    }))

  // Variants store option_value_ids sorted by uuid (the database normalises them
  // so the uniqueness index works). Display order must come from the options, so
  // map each id back to its position in the option list.
  const valueLabelById = new Map<string, { optionIndex: number; value: string }>()
  options.forEach((option, optionIndex) => {
    for (const value of option.values) {
      if (value.id) valueLabelById.set(value.id, { optionIndex, value: value.value })
    }
  })

  type RawVariant = {
    id: string
    sku: string | null
    barcode: string | null
    price_centavos: number | string
    compare_at_price_centavos: number | string | null
    cost_centavos: number | string | null
    weight_grams: number | null
    option_value_ids: string[] | null
    position: number
  }

  const variants: DraftVariant[] = ((data.product_variants ?? []) as RawVariant[])
    .map((variant) => {
      const ordered = new Array<string>(options.length).fill('')
      for (const id of variant.option_value_ids ?? []) {
        const found = valueLabelById.get(id)
        if (found) ordered[found.optionIndex] = found.value
      }
      return {
        id: variant.id,
        values: options.length === 0 ? [] : ordered,
        sku: variant.sku ?? '',
        price: fromDb(variant.price_centavos),
        compareAtPrice:
          variant.compare_at_price_centavos === null
            ? null
            : fromDb(variant.compare_at_price_centavos),
        cost: variant.cost_centavos === null ? null : fromDb(variant.cost_centavos),
        weightGrams: variant.weight_grams,
        position: variant.position,
      }
    })
    .sort((a, b) => a.position - b.position)
    .map(({ position: _position, ...variant }) => variant)

  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    description: data.description ?? '',
    status: data.status as ProductStatus,
    categoryId: data.category_id,
    isCodAllowed: data.is_cod_allowed,
    weightGrams: data.weight_grams,
    options,
    variants,
    images: ((data.product_images ?? []) as {
      id: string
      storage_path: string
      alt: string | null
      sort_order: number
    }[])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((image) => ({
        id: image.id,
        storagePath: image.storage_path,
        alt: image.alt,
        sortOrder: image.sort_order,
      })),
  }
}

export interface SaveProductInput {
  id?: string
  name: string
  description: string
  status: ProductStatus
  categoryId: string | null
  isCodAllowed: boolean
  weightGrams: number | null
  options: DraftOption[]
  variants: DraftVariant[]
}

/**
 * Create or update a product with its options, values and variants.
 *
 * Sequenced deliberately: options and values first, then variants, because a
 * variant references value ids that must already exist. The database enforces the
 * "exactly one value per option" invariant immediately on each variant write, so a
 * partial save fails loudly at the offending row rather than leaving a catalog that
 * looks fine and cannot be shipped.
 *
 * Not wrapped in a single transaction — PostgREST cannot express one across
 * requests. Phase 4 moves this into an RPC when inventory makes atomicity
 * genuinely load-bearing; today a failed save leaves a draft the seller can retry.
 */
export async function saveProduct(
  tenantId: string,
  input: SaveProductInput,
  client: SelldClient = getSupabase(),
): Promise<string> {
  const productRow = {
    tenant_id: tenantId,
    name: input.name.trim(),
    slug: slugForCatalog(input.name),
    description: input.description.trim() || null,
    status: input.status,
    category_id: input.categoryId,
    is_cod_allowed: input.isCodAllowed,
    weight_grams: input.weightGrams,
  }

  let productId = input.id

  if (productId) {
    const { error } = await client.from('products').update(productRow).eq('id', productId)
    if (error) throw error
  } else {
    const { data, error } = await client.from('products').insert(productRow).select('id').single()
    if (error) throw error
    productId = data.id
  }

  // Replace the option structure wholesale. Options and values are cheap, carry no
  // inventory, and cascade to nothing except through variants — which are diffed
  // separately below precisely so their stock survives.
  const existingBefore = await fetchProduct(productId, client)
  const { error: deleteOptionsError } = await client
    .from('product_options')
    .delete()
    .eq('product_id', productId)
  if (deleteOptionsError) throw deleteOptionsError

  const valueIdByLabel = new Map<string, string>()

  for (const [optionIndex, option] of input.options.entries()) {
    const { data: optionRow, error: optionError } = await client
      .from('product_options')
      .insert({
        tenant_id: tenantId,
        product_id: productId,
        name: option.name.trim(),
        sort_order: optionIndex,
      })
      .select('id')
      .single()
    if (optionError) throw optionError

    const valueRows = option.values.map((value, valueIndex) => ({
      tenant_id: tenantId,
      option_id: optionRow.id,
      value: value.value.trim(),
      sort_order: valueIndex,
    }))

    const { data: insertedValues, error: valuesError } = await client
      .from('product_option_values')
      .insert(valueRows)
      .select('id, value')
    if (valuesError) throw valuesError

    for (const row of insertedValues ?? []) {
      valueIdByLabel.set(`${optionIndex}${row.value}`, row.id)
    }
  }

  const diff = diffVariants(input.variants, existingBefore?.variants ?? [])

  const toRow = (variant: DraftVariant, position: number) => ({
    tenant_id: tenantId,
    product_id: productId as string,
    sku: variant.sku.trim() || null,
    price_centavos: variant.price,
    compare_at_price_centavos: variant.compareAtPrice,
    cost_centavos: variant.cost,
    weight_grams: variant.weightGrams,
    position,
    option_value_ids: variant.values
      .map((value, optionIndex) => valueIdByLabel.get(`${optionIndex}${value}`))
      .filter((id): id is string => id !== undefined),
  })

  if (diff.deletedIds.length > 0) {
    const { error } = await client.from('product_variants').delete().in('id', diff.deletedIds)
    if (error) throw error
  }

  // Every surviving variant needs its option_value_ids rewritten, because the
  // option rows were just recreated and the old ids no longer exist.
  for (const [position, variant] of input.variants.entries()) {
    const row = toRow(variant, position)
    const isExisting = variant.id !== undefined && !diff.deletedIds.includes(variant.id)

    if (isExisting) {
      const { error } = await client
        .from('product_variants')
        .update(row)
        .eq('id', variant.id as string)
      if (error) throw error
    } else {
      const { error } = await client.from('product_variants').insert(row)
      if (error) throw error
    }
  }

  return productId
}

export async function setProductStatus(
  productId: string,
  status: ProductStatus,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('products').update({ status }).eq('id', productId)
  if (error) throw error
}

export async function deleteProduct(
  productId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('products').delete().eq('id', productId)
  if (error) throw error
}

/** Every variant of a tenant, flattened for CSV export. */
export async function fetchCatalogForExport(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<ProductDetail[]> {
  const { data, error } = await client
    .from('products')
    .select('id')
    .eq('tenant_id', tenantId)
    .order('name')

  if (error) throw error

  const details: ProductDetail[] = []
  for (const row of data ?? []) {
    const detail = await fetchProduct(row.id, client)
    if (detail) details.push(detail)
  }
  return details
}
