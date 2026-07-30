import type { PhAddressValue } from '@/features/address/ph-address'
import type { Database } from '@/lib/supabase/database.types'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'

type TenantUpdate = Database['public']['Tables']['tenants']['Update']
type ThemeUpdate = Database['public']['Tables']['storefront_themes']['Update']

/** The bucket created in the phase 2 migration. Objects are `{tenant_id}/…`. */
export const TENANT_ASSET_BUCKET = 'tenant-public'

export const MAX_LOGO_BYTES = 2 * 1024 * 1024
export const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export class LogoValidationError extends Error {
  readonly reason: 'too_large' | 'wrong_type'
  constructor(reason: 'too_large' | 'wrong_type') {
    super(reason)
    this.name = 'LogoValidationError'
    this.reason = reason
  }
}

export function validateLogoFile(file: { size: number; type: string }): void {
  if (!(ALLOWED_LOGO_TYPES as readonly string[]).includes(file.type)) {
    throw new LogoValidationError('wrong_type')
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new LogoValidationError('too_large')
  }
}

/**
 * Downscale an image in the browser before upload.
 *
 * Sellers upload straight from the camera roll, where a 4 MB, 4000px photo is
 * normal. Uploading that costs them mobile data they are paying for, and the
 * storefront only ever renders the logo a few hundred pixels wide. Resizing
 * client-side turns a multi-megabyte upload into tens of kilobytes.
 *
 * Falls back to the original file if the browser cannot decode it — a slightly
 * expensive upload beats a blocked one.
 */
export async function downscaleImage(
  file: File,
  options: { maxEdge?: number; quality?: number } = {},
): Promise<Blob> {
  const { maxEdge = 512, quality = 0.85 } = options

  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    return file
  }

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))

    // Already small enough — re-encoding would only lose quality.
    if (scale === 1) {
      bitmap.close?.()
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)

    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close?.()
      return file
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()

    // PNG for transparency (logos often need it), WebP otherwise.
    const type = file.type === 'image/png' ? 'image/png' : 'image/webp'
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, quality)
    })
    return blob ?? file
  } catch {
    return file
  }
}

/**
 * Upload a tenant logo and return its storage path.
 *
 * The path is `{tenant_id}/logo-{timestamp}.{ext}`. The tenant id prefix is the
 * authorisation boundary — the storage policies check that the caller is an admin
 * of the tenant named in the first path segment. The timestamp busts CDN caches,
 * which a fixed `logo.png` would not.
 */
export async function uploadTenantLogo(
  tenantId: string,
  file: File,
  client: SelldClient = getSupabase(),
): Promise<string> {
  validateLogoFile(file)

  const blob = await downscaleImage(file)
  const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'
  const path = `${tenantId}/logo-${Date.now()}.${extension}`

  const { error } = await client.storage.from(TENANT_ASSET_BUCKET).upload(path, blob, {
    contentType: blob.type,
    upsert: true,
  })
  if (error) throw error

  return path
}

export function publicAssetUrl(
  path: string | null,
  client: SelldClient = getSupabase(),
): string | null {
  if (!path) return null
  return client.storage.from(TENANT_ASSET_BUCKET).getPublicUrl(path).data.publicUrl
}

export async function removeTenantAsset(
  path: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.storage.from(TENANT_ASSET_BUCKET).remove([path])
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Tenant branding
// ---------------------------------------------------------------------------

export async function updateTenantBranding(
  tenantId: string,
  input: { name?: string; logoPath?: string | null; brandColor?: string | null },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const patch: TenantUpdate = {}
  if (input.name !== undefined) patch.name = input.name.trim()
  if (input.logoPath !== undefined) patch.logo_path = input.logoPath
  if (input.brandColor !== undefined) patch.brand_color = input.brandColor
  if (Object.keys(patch).length === 0) return

  const { error } = await client.from('tenants').update(patch).eq('id', tenantId)
  if (error) throw error
}

export type ThemePreset = 'clean' | 'bold' | 'warm' | 'mono'

export async function updateTheme(
  tenantId: string,
  input: { preset?: ThemePreset; colors?: Record<string, string> },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const patch: ThemeUpdate = {}
  if (input.preset !== undefined) patch.preset = input.preset
  if (input.colors !== undefined) patch.colors = input.colors
  if (Object.keys(patch).length === 0) return

  const { error } = await client.from('storefront_themes').update(patch).eq('tenant_id', tenantId)
  if (error) throw error
}

export async function fetchTheme(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<{ preset: ThemePreset; colors: Record<string, string> } | null> {
  const { data, error } = await client
    .from('storefront_themes')
    .select('preset, colors')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  return {
    preset: data.preset as ThemePreset,
    colors: (data.colors ?? {}) as Record<string, string>,
  }
}

// ---------------------------------------------------------------------------
// Shipping origin
// ---------------------------------------------------------------------------

export interface OriginLocation {
  id: string
  name: string
  address: PhAddressValue
  contactName: string
  contactPhone: string
}

export async function fetchDefaultLocation(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<OriginLocation | null> {
  const { data, error } = await client
    .from('locations')
    .select(
      'id, name, region_code, province_code, city_code, barangay_code, street, landmark, postal_code, contact_name, contact_phone',
    )
    .eq('tenant_id', tenantId)
    .eq('is_default', true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    id: data.id,
    name: data.name,
    address: {
      regionCode: data.region_code,
      provinceCode: data.province_code,
      cityCode: data.city_code,
      barangayCode: data.barangay_code,
      street: data.street ?? '',
      landmark: data.landmark ?? '',
      postalCode: data.postal_code ?? '',
    },
    contactName: data.contact_name ?? '',
    contactPhone: data.contact_phone ?? '',
  }
}

/**
 * Create or update the tenant's default shipping origin.
 *
 * Upsert-by-hand rather than a Postgres upsert: `locations` has no natural unique
 * key beyond the partial `is_default` index, and inserting a second default would
 * hit that index rather than updating the existing row.
 */
export async function saveDefaultLocation(
  tenantId: string,
  input: {
    name: string
    address: PhAddressValue
    contactName?: string
    contactPhone?: string | null
  },
  client: SelldClient = getSupabase(),
): Promise<string> {
  const row = {
    tenant_id: tenantId,
    name: input.name.trim() || 'Home',
    type: 'home' as const,
    is_default: true,
    region_code: input.address.regionCode,
    province_code: input.address.provinceCode,
    city_code: input.address.cityCode,
    barangay_code: input.address.barangayCode,
    street: input.address.street.trim() || null,
    landmark: input.address.landmark.trim() || null,
    postal_code: input.address.postalCode.trim() || null,
    contact_name: input.contactName?.trim() || null,
    contact_phone: input.contactPhone || null,
  }

  const existing = await fetchDefaultLocation(tenantId, client)

  if (existing) {
    const { error } = await client.from('locations').update(row).eq('id', existing.id)
    if (error) throw error
    return existing.id
  }

  const { data, error } = await client.from('locations').insert(row).select('id').single()
  if (error) throw error
  return data.id
}
