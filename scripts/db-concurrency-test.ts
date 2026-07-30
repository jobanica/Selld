/**
 * Phase 4 done-when: two concurrent checkouts for the last unit — exactly one
 * succeeds.
 *
 *   pnpm db:test:concurrency
 *
 * This cannot live in `supabase/tests/*.sql`. A single psql session runs statements
 * in order, so it can only *simulate* a race; overselling is a problem that exists
 * exclusively between real, simultaneous connections. So this opens genuine parallel
 * clients and lets them fight.
 *
 * Four scenarios, each testing something different:
 *
 *   1. Deterministic interleave — B blocks on A's advisory lock, then loses cleanly.
 *   2. Stochastic stampede — 20 clients race for 5 units; exactly 5 win.
 *   3. Deadlock avoidance — clients reserve {A,B} and {B,A} at once and both finish.
 *   4. Ledger invariant — sum(movements) still equals on_hand after all of it.
 *   5. Constraint backstop — the CHECK still holds with the advisory lock bypassed.
 */

import { Client } from 'pg'

const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function resolveDbUrl(): string {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    /* rely on the ambient environment */
  }
  return process.env.SUPABASE_DB_URL ?? DEFAULT_DB_URL
}

const DB_URL = resolveDbUrl()

let passed = 0
const failures: string[] = []

function ok(condition: boolean, message: string): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${String(passed).padStart(3)} ${message}`)
  } else {
    failures.push(message)
    console.error(`  FAIL    ${message}`)
  }
}

function eq<T>(actual: T, expected: T, message: string): void {
  ok(
    actual === expected,
    `${message}${actual === expected ? ` (= ${String(actual)})` : ` — expected ${String(expected)}, got ${String(actual)}`}`,
  )
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  return client
}

/** Impersonate a signed-in seller, exactly as the SQL suite does. */
async function login(client: Client, userId: string, email: string): Promise<void> {
  await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId])
  await client.query(`select set_config('request.jwt.claim.email', $1, false)`, [email])
  await client.query(`set role authenticated`)
}

const OWNER = '11111111-1111-1111-1111-111111111111'
const OWNER_EMAIL = 'rhea@example.ph'

interface Fixture {
  tenantId: string
  locationId: string
  variantA: string
  variantB: string
}

/**
 * Build a tenant with one location and two variants. Committed rather than rolled
 * back, because concurrent clients cannot see each other's uncommitted rows — the
 * whole point of the exercise.
 */
async function setup(): Promise<Fixture> {
  const admin = await connect()
  try {
    // Order matters: deleting a user who is the sole owner of a live tenant is
    // refused by design, so the tenant goes first.
    await admin.query(`delete from public.tenants where slug = 'concurrency-test'`)
    await admin.query(`delete from auth.users where email = $1`, [OWNER_EMAIL])

    await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [OWNER, OWNER_EMAIL])

    await admin.query(`select set_config('request.jwt.claim.sub', $1, false)`, [OWNER])
    await admin.query(`set role authenticated`)
    const tenant = await admin.query<{ id: string }>(
      `select id from public.create_tenant('Concurrency Test', 'concurrency-test')`,
    )
    const tenantId = tenant.rows[0]!.id
    await admin.query(`reset role`)

    const location = await admin.query<{ id: string }>(
      `insert into public.locations (tenant_id, name, is_default) values ($1, 'Home', true)
       returning id`,
      [tenantId],
    )
    // Two separate products, one variant each. A product with no options may have
    // exactly one variant — the unique index on (product_id, option_value_ids)
    // enforces that, and it caught an earlier version of this fixture.
    const products = await admin.query<{ id: string }>(
      `insert into public.products (tenant_id, name, slug, status) values
         ($1, 'Race Tee A', 'race-tee-a', 'active'),
         ($1, 'Race Tee B', 'race-tee-b', 'active')
       returning id`,
      [tenantId],
    )
    const variants = await admin.query<{ id: string }>(
      `insert into public.product_variants (tenant_id, product_id, sku, price_centavos) values
         ($1, $2, 'RACE-A', 49900),
         ($1, $3, 'RACE-B', 49900)
       returning id`,
      [tenantId, products.rows[0]!.id, products.rows[1]!.id],
    )

    return {
      tenantId,
      locationId: location.rows[0]!.id,
      variantA: variants.rows[0]!.id,
      variantB: variants.rows[1]!.id,
    }
  } finally {
    await admin.end()
  }
}

/** Put an exact quantity on hand, through the ledger like everything else. */
async function stock(fixture: Fixture, variantId: string, quantity: number): Promise<void> {
  const admin = await connect()
  try {
    await admin.query(`select set_config('request.jwt.claim.sub', $1, false)`, [OWNER])
    await admin.query(`set role authenticated`)
    await admin.query(`select public.release_reservation($1::uuid, $2::uuid, $3::jsonb)`, [
      fixture.tenantId,
      fixture.locationId,
      JSON.stringify([{ variant_id: variantId, qty: 1_000_000 }]),
    ])
    await admin.query(`select public.set_stock_level($1::uuid, $2::uuid, $3::uuid, $4::int, 'test fixture')`, [
      fixture.tenantId,
      variantId,
      fixture.locationId,
      quantity,
    ])
  } finally {
    await admin.end()
  }
}

async function readLevel(
  fixture: Fixture,
  variantId: string,
): Promise<{ onHand: number; reserved: number }> {
  const admin = await connect()
  try {
    const result = await admin.query<{ on_hand: number; reserved: number }>(
      `select on_hand, reserved from public.inventory_levels
        where variant_id = $1 and location_id = $2`,
      [variantId, fixture.locationId],
    )
    const row = result.rows[0]
    return { onHand: row?.on_hand ?? 0, reserved: row?.reserved ?? 0 }
  } finally {
    await admin.end()
  }
}

const isInsufficientStock = (error: unknown): boolean =>
  error instanceof Error && /Insufficient stock/i.test(error.message)

// ---------------------------------------------------------------------------
// 1. Deterministic interleave — THE done-when, with the race pinned open
// ---------------------------------------------------------------------------
async function testDeterministicRace(fixture: Fixture): Promise<void> {
  console.log('\n=== 1. Two checkouts, one unit, race held open')
  await stock(fixture, fixture.variantA, 1)

  const a = await connect()
  const b = await connect()
  try {
    await login(a, OWNER, OWNER_EMAIL)
    await login(b, OWNER, OWNER_EMAIL)

    await a.query('begin')
    await b.query('begin')

    const items = JSON.stringify([{ variant_id: fixture.variantA, qty: 1 }])

    // A reserves and holds its transaction open, keeping the advisory lock.
    await a.query(`select public.reserve_stock($1::uuid, $2::uuid, $3::jsonb)`, [
      fixture.tenantId,
      fixture.locationId,
      items,
    ])
    ok(true, 'client A reserved the last unit')

    // B now attempts the same unit. It must BLOCK on A's lock rather than read
    // stale availability — so this promise stays pending until A commits.
    let bSettled = false
    const bAttempt = b
      .query(`select public.reserve_stock($1::uuid, $2::uuid, $3::jsonb)`, [
        fixture.tenantId,
        fixture.locationId,
        items,
      ])
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }))
      .finally(() => {
        bSettled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 600))
    ok(!bSettled, 'client B blocked on the advisory lock instead of reading stale stock')

    await a.query('commit')

    const outcome = await bAttempt
    ok(!outcome.ok, 'client B failed once A committed')
    ok(
      !outcome.ok && isInsufficientStock(outcome.error),
      'client B got a business error ("Insufficient stock"), not a constraint violation',
    )

    await b.query('rollback')

    const level = await readLevel(fixture, fixture.variantA)
    eq(level.reserved, 1, 'exactly one unit ended up reserved')
    eq(level.onHand, 1, 'on_hand is untouched — a reservation is not a movement')
  } finally {
    await a.end()
    await b.end()
  }
}

// ---------------------------------------------------------------------------
// 2. Stochastic stampede — the live-selling case
// ---------------------------------------------------------------------------
async function testStampede(fixture: Fixture): Promise<void> {
  const CLIENTS = 20
  const UNITS = 5
  console.log(`\n=== 2. ${CLIENTS} simultaneous buyers, ${UNITS} units`)
  await stock(fixture, fixture.variantA, UNITS)

  const clients = await Promise.all(Array.from({ length: CLIENTS }, () => connect()))
  try {
    await Promise.all(clients.map((client) => login(client, OWNER, OWNER_EMAIL)))

    const items = JSON.stringify([{ variant_id: fixture.variantA, qty: 1 }])

    // Fire all at once. No barrier, no ordering — a real stampede, which is what a
    // live selling session with 200 "MINE po" comments actually looks like.
    const results = await Promise.all(
      clients.map((client) =>
        client
          .query(`select public.reserve_stock($1::uuid, $2::uuid, $3::jsonb)`, [
            fixture.tenantId,
            fixture.locationId,
            items,
          ])
          .then(() => 'won' as const)
          .catch((error: unknown) => (isInsufficientStock(error) ? 'lost' : ('error' as const))),
      ),
    )

    const won = results.filter((result) => result === 'won').length
    const lost = results.filter((result) => result === 'lost').length
    const errored = results.filter((result) => result === 'error').length

    eq(won, UNITS, `exactly ${UNITS} buyers won`)
    eq(lost, CLIENTS - UNITS, `the other ${CLIENTS - UNITS} were told stock ran out`)
    eq(errored, 0, 'nobody hit an unexpected error — every loss was a clean business error')

    const level = await readLevel(fixture, fixture.variantA)
    eq(level.reserved, UNITS, 'reserved equals the units that existed — not one more')
    ok(level.reserved <= level.onHand, 'the no-oversell invariant held under load')
  } finally {
    await Promise.all(clients.map((client) => client.end()))
  }
}

// ---------------------------------------------------------------------------
// 3. Deadlock avoidance
// ---------------------------------------------------------------------------
async function testDeadlockAvoidance(fixture: Fixture): Promise<void> {
  console.log('\n=== 3. Opposing multi-variant carts (deadlock avoidance)')
  await stock(fixture, fixture.variantA, 10)
  await stock(fixture, fixture.variantB, 10)

  const a = await connect()
  const b = await connect()
  try {
    await login(a, OWNER, OWNER_EMAIL)
    await login(b, OWNER, OWNER_EMAIL)

    // Cart 1 wants A then B; cart 2 wants B then A. Locking in the order given
    // would deadlock and Postgres would kill one — a failed checkout for a buyer
    // who did nothing wrong. reserve_stock() sorts, so this cannot happen.
    const forward = JSON.stringify([
      { variant_id: fixture.variantA, qty: 1 },
      { variant_id: fixture.variantB, qty: 1 },
    ])
    const reverse = JSON.stringify([
      { variant_id: fixture.variantB, qty: 1 },
      { variant_id: fixture.variantA, qty: 1 },
    ])

    const results = await Promise.all([
      a
        .query(`select public.reserve_stock($1::uuid, $2::uuid, $3::jsonb)`, [
          fixture.tenantId,
          fixture.locationId,
          forward,
        ])
        .then(() => 'ok' as const)
        .catch((error: unknown) => (error instanceof Error ? error.message : 'error')),
      b
        .query(`select public.reserve_stock($1::uuid, $2::uuid, $3::jsonb)`, [
          fixture.tenantId,
          fixture.locationId,
          reverse,
        ])
        .then(() => 'ok' as const)
        .catch((error: unknown) => (error instanceof Error ? error.message : 'error')),
    ])

    eq(results[0], 'ok', 'the cart wanting A then B succeeded')
    eq(results[1], 'ok', 'the cart wanting B then A succeeded')
    ok(
      !results.some((result) => typeof result === 'string' && /deadlock/i.test(result)),
      'no deadlock — locks are acquired in sorted order',
    )
  } finally {
    await a.end()
    await b.end()
  }
}

// ---------------------------------------------------------------------------
// 4. Ledger invariant
// ---------------------------------------------------------------------------
async function testLedgerInvariant(fixture: Fixture): Promise<void> {
  console.log('\n=== 4. Ledger invariant after all that contention')
  const admin = await connect()
  try {
    const result = await admin.query<{ variant_id: string; on_hand: number; ledger: string }>(
      `select il.variant_id,
              il.on_hand,
              coalesce(sum(m.delta), 0)::text as ledger
         from public.inventory_levels il
         left join public.stock_movements m
                on m.variant_id = il.variant_id
               and m.location_id = il.location_id
        where il.tenant_id = $1
        group by il.variant_id, il.on_hand`,
      [fixture.tenantId],
    )

    ok(result.rows.length > 0, 'there is inventory to check')
    for (const row of result.rows) {
      eq(
        row.on_hand,
        Number(row.ledger),
        `on_hand equals the sum of its movements for variant ${row.variant_id.slice(0, 8)}`,
      )
    }

    // And the guard that keeps it that way.
    await admin.query(`select set_config('request.jwt.claim.sub', $1, false)`, [OWNER])
    await admin.query(`set role authenticated`)
    let rejected = false
    try {
      await admin.query(
        `update public.inventory_levels set on_hand = 999 where tenant_id = $1`,
        [fixture.tenantId],
      )
    } catch (error) {
      rejected = error instanceof Error && /derived from stock_movements/.test(error.message)
    }
    ok(rejected, 'a direct write to on_hand is rejected — the ledger stays authoritative')

    await admin.query('reset role')

    // Append-only.
    let ledgerImmutable = false
    try {
      await admin.query(`update public.stock_movements set delta = 0 where tenant_id = $1`, [
        fixture.tenantId,
      ])
    } catch (error) {
      ledgerImmutable = error instanceof Error && /append-only/.test(error.message)
    }
    ok(ledgerImmutable, 'the ledger cannot be edited — corrections are compensating movements')
  } finally {
    await admin.end()
  }
}

// ---------------------------------------------------------------------------
// 5. The CHECK constraint as a backstop, with the lock deliberately bypassed
// ---------------------------------------------------------------------------
/**
 * Defence in depth, actually verified.
 *
 * Sabotage runs showed the two layers are caught by different tests: removing the
 * advisory lock is caught by scenario 3 (deadlock), while removing the CHECK
 * constraint leaves scenarios 1-3 green — because the lock alone serialises the
 * reservations, so the constraint never gets a chance to fire.
 *
 * That makes "the constraint protects us even if a future code path forgets the
 * lock" an untested claim. This scenario tests it: two clients bypass
 * reserve_stock() entirely and issue a raw unconditional UPDATE, exactly as careless
 * future code would. The constraint must still refuse to oversell.
 */
async function testConstraintBackstop(fixture: Fixture): Promise<void> {
  console.log('\n=== 5. Raw UPDATEs with no lock — the CHECK constraint alone')
  await stock(fixture, fixture.variantA, 1)

  const a = await connect()
  const b = await connect()
  try {
    // As the table owner, so RLS is not what stops this — only the constraint.
    const raw = `update public.inventory_levels
                    set reserved = reserved + 1
                  where variant_id = $1::uuid and location_id = $2::uuid`

    await a.query('begin')
    await b.query('begin')

    await a.query(raw, [fixture.variantA, fixture.locationId])

    // B blocks on the ROW lock (not an advisory one), then re-evaluates after A
    // commits and hits the constraint.
    const bAttempt = b
      .query(raw, [fixture.variantA, fixture.locationId])
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }))

    await a.query('commit')
    const outcome = await bAttempt

    ok(!outcome.ok, 'the second unconditional UPDATE was refused')
    ok(
      !outcome.ok &&
        outcome.error instanceof Error &&
        /inventory_no_oversell/.test(outcome.error.message),
      'refused by the inventory_no_oversell CHECK — the constraint, not the lock',
    )

    await b.query('rollback').catch(() => undefined)

    const level = await readLevel(fixture, fixture.variantA)
    eq(level.reserved, 1, 'still exactly one unit reserved')
    ok(level.reserved <= level.onHand, 'the invariant held with no advisory lock involved')
  } finally {
    await a.end()
    await b.end()
  }
}

async function teardown(fixture: Fixture): Promise<void> {
  const admin = await connect()
  try {
    await admin.query(`delete from public.tenants where id = $1`, [fixture.tenantId])
    await admin.query(`delete from auth.users where email = $1`, [OWNER_EMAIL])
  } finally {
    await admin.end()
  }
}

async function main(): Promise<void> {
  console.log('Inventory concurrency tests')
  console.log(`  -> ${DB_URL.replace(/:[^:@/]*@/, ':****@')}`)

  const fixture = await setup()
  try {
    await testDeterministicRace(fixture)
    await testStampede(fixture)
    await testDeadlockAvoidance(fixture)
    await testLedgerInvariant(fixture)
    await testConstraintBackstop(fixture)
  } finally {
    await teardown(fixture)
  }

  console.log()
  if (failures.length > 0) {
    console.error(`${failures.length} assertion(s) FAILED:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`=== ${passed} assertions passed`)
}

main().catch((error: unknown) => {
  console.error('\nconcurrency test failed:', error instanceof Error ? error.stack : error)
  process.exit(1)
})
