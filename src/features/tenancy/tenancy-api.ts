import type { TenantRole } from '@/core/tenancy'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'

/**
 * Tenancy reads and writes.
 *
 * Every function here is a thin wrapper over an RLS-protected table or an RPC.
 * There is no client-side tenant filtering anywhere in this file on purpose: if a
 * query could return another tenant's row, the fix belongs in a policy, not in a
 * `.eq('tenant_id', …)` the client could forget.
 */

export interface TenantSummary {
  id: string
  name: string
  slug: string
  logoPath: string | null
  brandColor: string | null
  status: string
  role: TenantRole
  joinedAt: string | null
}

/** Tenants the signed-in user can switch between. */
export async function fetchMyTenants(
  client: SelldClient = getSupabase(),
): Promise<TenantSummary[]> {
  const { data, error } = await client.rpc('my_tenants')
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoPath: row.logo_path,
    brandColor: row.brand_color,
    status: row.status,
    role: row.role,
    joinedAt: row.joined_at,
  }))
}

export async function createTenant(
  input: { name: string; slug: string },
  client: SelldClient = getSupabase(),
): Promise<{ id: string; name: string; slug: string }> {
  const { data, error } = await client.rpc('create_tenant', {
    p_name: input.name,
    p_slug: input.slug,
  })
  if (error) throw error
  if (!data) throw new Error('create_tenant returned no tenant')
  return { id: data.id, name: data.name, slug: data.slug }
}

/**
 * Is a slug available?
 *
 * Checks the public storefront projection, which is readable anonymously, so this
 * works during onboarding before the tenant exists. Advisory only — the unique
 * constraint is what actually decides, and `createTenant` surfaces that.
 */
export async function isSlugAvailable(
  slug: string,
  client: SelldClient = getSupabase(),
): Promise<boolean> {
  const { count, error } = await client
    .from('storefront_tenants')
    .select('slug', { count: 'exact', head: true })
    .eq('slug', slug.toLowerCase())

  if (error) throw error
  return (count ?? 0) === 0
}

/** Resolve a storefront by subdomain slug. Works without a session. */
export async function fetchStorefrontBySlug(
  slug: string,
  client: SelldClient = getSupabase(),
): Promise<{
  id: string
  name: string
  slug: string
  logoPath: string | null
  brandColor: string | null
  locale: string
} | null> {
  const { data, error } = await client
    .from('storefront_tenants')
    .select('id, name, slug, logo_path, brand_color, locale')
    .eq('slug', slug.toLowerCase())
    .maybeSingle()

  if (error) throw error
  if (!data || data.id === null || data.name === null || data.slug === null) return null

  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    logoPath: data.logo_path,
    brandColor: data.brand_color,
    locale: data.locale ?? 'en',
  }
}

/** Resolve a storefront by custom domain. */
export async function fetchStorefrontByDomain(
  hostname: string,
  client: SelldClient = getSupabase(),
): Promise<{ id: string; name: string; slug: string } | null> {
  const { data, error } = await client
    .from('storefront_tenants')
    .select('id, name, slug')
    .eq('custom_domain', hostname.toLowerCase())
    .maybeSingle()

  if (error) throw error
  if (!data || data.id === null || data.name === null || data.slug === null) return null
  return { id: data.id, name: data.name, slug: data.slug }
}

export interface TeamMember {
  id: string
  userId: string
  role: TenantRole
  acceptedAt: string | null
  fullName: string | null
  phone: string | null
}

/**
 * The roster for a tenant.
 *
 * `tenant_id` is passed so the caller states which tenant it means, but RLS is
 * what enforces the answer — asking for a tenant you do not belong to returns
 * zero rows rather than an error.
 */
export async function fetchTeam(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<TeamMember[]> {
  const { data, error } = await client
    .from('tenant_members')
    .select('id, user_id, role, accepted_at, profiles(full_name, phone)')
    .eq('tenant_id', tenantId)
    .order('created_at')

  if (error) throw error

  return (data ?? []).map((row) => {
    const profile = row.profiles as { full_name: string | null; phone: string | null } | null
    return {
      id: row.id,
      userId: row.user_id,
      role: row.role,
      acceptedAt: row.accepted_at,
      fullName: profile?.full_name ?? null,
      phone: profile?.phone ?? null,
    }
  })
}

export async function inviteMember(
  input: { tenantId: string; email: string; role: TenantRole },
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.from('invitations').insert({
    tenant_id: input.tenantId,
    email: input.email.trim().toLowerCase(),
    role: input.role,
  })
  if (error) throw error
}

export async function acceptInvitation(
  token: string,
  client: SelldClient = getSupabase(),
): Promise<{ tenantId: string; role: TenantRole }> {
  const { data, error } = await client.rpc('accept_invitation', { p_token: token })
  if (error) throw error
  if (!data) throw new Error('accept_invitation returned nothing')
  return { tenantId: data.tenant_id, role: data.role }
}
