import { getSupabase, type SelldClient } from '@/lib/supabase/client'

import { parseSettings, type SettingKey, type TenantSettings } from './keys'

/** Read every setting for a tenant, with defaults filled in. */
export async function fetchSettings(
  tenantId: string,
  client: SelldClient = getSupabase(),
): Promise<TenantSettings> {
  const { data, error } = await client
    .from('tenant_settings')
    .select('key, value')
    .eq('tenant_id', tenantId)

  if (error) throw error
  return parseSettings(data ?? [])
}

/**
 * Write one or more settings.
 *
 * Upserts on `(tenant_id, key)` so a key seeded by the tenant trigger and a key
 * written for the first time take the same path — the caller never has to know
 * which case it is in.
 */
export async function writeSettings(
  tenantId: string,
  values: Partial<TenantSettings>,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const rows = (Object.entries(values) as [SettingKey, unknown][])
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ tenant_id: tenantId, key, value: value as never }))

  if (rows.length === 0) return

  const { error } = await client
    .from('tenant_settings')
    .upsert(rows, { onConflict: 'tenant_id,key' })

  if (error) throw error
}
