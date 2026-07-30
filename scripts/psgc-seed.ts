/**
 * Load `supabase/seed/psgc.json.gz` into the PSGC reference tables.
 *
 *   pnpm psgc:seed                     # uses SUPABASE_DB_URL
 *   SUPABASE_DB_URL=postgres://… pnpm psgc:seed
 *
 * Idempotent: upserts by primary key, so re-running after a PSA update applies
 * only the changes. Insert order follows the foreign keys
 * (regions -> provinces -> cities -> barangays).
 *
 * Runs as the database owner and therefore bypasses RLS, which is why the tables
 * need no write policies.
 */

import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

import type { PsgcSeed } from './psgc-build.ts'

const SEED_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../supabase/seed/psgc.json.gz',
)

const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

/** Rows per statement. Keeps parameter counts well under Postgres' 65,535 cap. */
const BATCH_SIZE = 1_000

function loadSeed(): PsgcSeed {
  let compressed: Buffer
  try {
    compressed = readFileSync(SEED_PATH)
  } catch {
    throw new Error(
      `Seed file not found at ${SEED_PATH}. Generate it first with: pnpm psgc:build`,
    )
  }
  return JSON.parse(gunzipSync(compressed).toString('utf8')) as PsgcSeed
}

function resolveDbUrl(): string {
  // Node 22 can read .env.local directly; ignore its absence.
  try {
    process.loadEnvFile('.env.local')
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
  return process.env.SUPABASE_DB_URL ?? DEFAULT_DB_URL
}

/**
 * Upsert rows in batches.
 *
 * Builds a single multi-row INSERT ... ON CONFLICT per batch. Deliberately not
 * COPY: COPY cannot upsert, and an idempotent seeder is worth more here than the
 * few hundred milliseconds COPY would save on 42k rows.
 */
async function upsert(
  client: Client,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return

  const updates = columns
    .filter((column) => column !== 'code')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')

  let inserted = 0
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE)
    const values: unknown[] = []
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column] ?? null)
        return `$${rowIndex * columns.length + columnIndex + 1}`
      })
      return `(${placeholders.join(', ')})`
    })

    await client.query(
      `insert into ${table} (${columns.join(', ')})
       values ${tuples.join(', ')}
       on conflict (code) do update set ${updates}`,
      values,
    )

    inserted += batch.length
    process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}`)
  }
  process.stdout.write('\n')
}

async function main(): Promise<void> {
  const seed = loadSeed()
  const dbUrl = resolveDbUrl()

  console.log(`Seeding PSGC data (generated ${seed.generatedAt})`)
  console.log(`  -> ${dbUrl.replace(/:[^:@/]*@/, ':****@')}\n`)

  const client = new Client({ connectionString: dbUrl })
  await client.connect()

  try {
    await client.query('begin')

    await upsert(client, 'public.psgc_regions', ['code', 'name', 'region_name', 'island_group'], seed.regions)
    await upsert(client, 'public.psgc_provinces', ['code', 'name', 'region_code', 'island_group'], seed.provinces)
    await upsert(
      client,
      'public.psgc_cities',
      [
        'code',
        'name',
        'old_name',
        'is_capital',
        'is_city',
        'is_municipality',
        'province_code',
        'district_code',
        'region_code',
        'island_group',
      ],
      seed.cities,
    )
    await upsert(
      client,
      'public.psgc_barangays',
      [
        'code',
        'name',
        'old_name',
        'city_code',
        'sub_municipality_code',
        'province_code',
        'region_code',
      ],
      seed.barangays,
    )

    await client.query('commit')

    const { rows } = await client.query<{ table_name: string; count: string }>(`
      select 'regions' as table_name, count(*)::text from public.psgc_regions
      union all select 'provinces', count(*)::text from public.psgc_provinces
      union all select 'cities', count(*)::text from public.psgc_cities
      union all select 'barangays', count(*)::text from public.psgc_barangays
    `)

    console.log('\nRow counts:')
    for (const row of rows) {
      console.log(`  ${row.table_name.padEnd(10)} ${row.count}`)
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    await client.end()
  }

  console.log('\nDone.')
}

main().catch((error: unknown) => {
  console.error('\npsgc:seed failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
