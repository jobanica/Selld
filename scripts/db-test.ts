/**
 * Run the SQL test suites in `supabase/tests/`.
 *
 *   pnpm db:test
 *   SUPABASE_DB_URL=postgres://… pnpm db:test
 *
 * Each file runs in its own transaction and rolls back, so the suite is safe to
 * run repeatedly against a database with real data in it.
 *
 * Uses `psql` when available (it gives the nicest output and honours `\echo`),
 * and falls back to executing the file through `pg` when it is not — sellers'
 * laptops and CI images do not always have the Postgres client installed.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/tests')
const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function resolveDbUrl(): string {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
  return process.env.SUPABASE_DB_URL ?? DEFAULT_DB_URL
}

function hasPsql(): boolean {
  const probe = spawnSync('psql', ['--version'], { stdio: 'ignore' })
  return probe.status === 0
}

function runWithPsql(dbUrl: string, file: string): boolean {
  const result = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
    stdio: 'inherit',
  })
  return result.status === 0
}

/**
 * Fallback path. `pg` cannot process psql meta-commands, so strip them — they are
 * only `\echo` / `\set` progress output, never assertions.
 */
async function runWithPg(dbUrl: string, file: string): Promise<boolean> {
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n')

  const client = new Client({ connectionString: dbUrl })
  // Surface the RAISE NOTICE assertion log, which is the whole point of the run.
  client.on('notice', (notice) => {
    if (notice.message) console.log(notice.message)
  })

  await client.connect()
  try {
    await client.query(sql)
    return true
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    // The suite's own `rollback` never ran, so undo the open transaction.
    try {
      await client.query('rollback')
    } catch {
      /* already aborted */
    }
    return false
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const dbUrl = resolveDbUrl()
  const files = readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.error(`No .sql test files found in ${TESTS_DIR}`)
    process.exit(1)
  }

  const usePsql = hasPsql()
  console.log(`Running ${files.length} SQL test file(s) via ${usePsql ? 'psql' : 'pg'}`)
  console.log(`  -> ${dbUrl.replace(/:[^:@/]*@/, ':****@')}\n`)

  const failed: string[] = []
  for (const name of files) {
    const file = join(TESTS_DIR, name)
    console.log(`--- ${name}`)
    const ok = usePsql ? runWithPsql(dbUrl, file) : await runWithPg(dbUrl, file)
    if (!ok) failed.push(name)
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} SQL test file(s) FAILED: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log('\nAll SQL tests passed.')
}

main().catch((error: unknown) => {
  console.error('\ndb:test failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
