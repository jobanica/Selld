import type { StatementCourier } from '@/core/cod/statement'
import { parseStatementFile, StatementError, toImportPayload } from '@/core/cod/statement'
import { readXlsx, XlsxError } from '@/core/cod/xlsx'
import { getSupabase, type SelldClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/supabase/errors'

/**
 * COD reconciliation, seller side.
 *
 * The statement file is parsed **in the browser**. It is the seller's own file, a
 * 3,000-row spreadsheet has no business making two network trips to be read, and
 * the parse needs no privileges at all.
 *
 * What the browser cannot be trusted with is what a line *means*. `cod_import_statement`
 * takes only the numbers the courier wrote down — waybill, amount, fee, date — and
 * decides against the seller's own shipments whether each one matches. A client
 * that could assert `match_status` could assert that an unpaid order was paid.
 */

export interface CodBucket {
  d0_7: number
  d8_14: number
  d15_30: number
  d31: number
}

export interface OutstandingParcel {
  orderId: string
  orderNumber: string
  contactName: string
  courier: string
  waybill: string
  amount: number
  deliveredAt: string
  ageDays: number
}

export interface CodReconciliation {
  sinceDays: number
  outstanding: {
    count: number
    amount: number
    buckets: CodBucket
    overdueCount: number
    byCourier: { courier: string; count: number; amount: number; oldestDays: number }[]
    parcels: OutstandingParcel[]
  }
  inTransit: { count: number; amount: number }
  returned: { count: number; amount: number; cost: number }
  remitted: { count: number; amount: number; variance: number }
  unaccounted: {
    overdue: { orderNumber: string; courier: string; waybill: string; amount: number; ageDays: number }[]
    unknownWaybills: { waybill: string; amount: number; courier: string; batchId: string }[]
    variances: {
      orderNumber: string | null
      waybill: string
      expected: number | null
      received: number
      variance: number
      courier: string
    }[]
  }
  batches: CodBatch[]
}

export interface CodBatch {
  id: string
  courier: string
  reference: string | null
  filename: string | null
  status: 'draft' | 'posted' | 'discarded'
  createdAt: string
  postedAt: string | null
  lineCount: number
  problemCount: number
  amount: number
}

export type MatchStatus = 'matched' | 'variance' | 'unknown_waybill' | 'duplicate' | 'not_cod'

export interface CodLine {
  id: string
  rowNumber: number
  waybill: string
  amount: number
  fee: number
  remittedAt: string | null
  matchStatus: MatchStatus
  variance: number
  orderNumber: string | null
  contactName: string | null
  due: number | null
}

export interface ImportSummary {
  id: string
  courier: string
  reference: string | null
  filename: string | null
  status: 'draft' | 'posted' | 'discarded'
  createdAt: string
  postedAt: string | null
  declaredTotal: number | null
  lineTotal: number
  lineCount: number
  byStatus: Partial<Record<MatchStatus, { count: number; amount: number; variance: number }>>
}

export async function fetchReconciliation(
  tenantId: string,
  days = 90,
  client: SelldClient = getSupabase(),
): Promise<CodReconciliation> {
  const { data, error } = await client.rpc('cod_reconciliation', {
    p_tenant_id: tenantId,
    p_days: days,
  })
  if (error) throw error
  return data as unknown as CodReconciliation
}

export async function fetchBatchLines(
  remittanceId: string,
  onlyProblems: boolean,
  client: SelldClient = getSupabase(),
): Promise<CodLine[]> {
  const { data, error } = await client.rpc('cod_remittance_lines', {
    p_remittance_id: remittanceId,
    p_only_problems: onlyProblems,
    p_limit: 500,
  })
  if (error) throw error
  return (data ?? []) as unknown as CodLine[]
}

/**
 * Read the seller's file, then hand the database its numbers.
 *
 * Returns the parse alongside the import summary so the screen can show "we read
 * your `Waybill No.` column as the waybill" — a seller whose file was mis-read
 * needs to see *how* it was read, not just that 40 lines did not match.
 */
export async function importStatement(
  tenantId: string,
  courier: StatementCourier,
  file: File,
  client: SelldClient = getSupabase(),
): Promise<{ summary: ImportSummary; columns: Record<string, string | null>; skipped: number }> {
  const statement = await parseStatementFile(await file.arrayBuffer(), courier, readXlsx)

  const { data, error } = await client.rpc('cod_import_statement', {
    p_tenant_id: tenantId,
    p_courier: courier,
    p_lines: toImportPayload(statement) as never,
    // Omitted rather than sent as null, and that is safe *here* specifically
    // because these three have SQL defaults. Where an argument has no default,
    // it must be sent as an explicit null: PostgREST resolves an overload by the
    // set of argument *names* in the body, and a key `JSON.stringify` drops is a
    // key it never sees — the call then 404s against a function that is right
    // there, with a hint naming the signature you meant.
    p_filename: file.name,
    ...(statement.declaredTotal === null ? {} : { p_declared_total: statement.declaredTotal }),
  })
  if (error) throw error

  return {
    summary: data as unknown as ImportSummary,
    columns: statement.columns,
    skipped: statement.skipped.length,
  }
}

export async function postBatch(
  remittanceId: string,
  client: SelldClient = getSupabase(),
): Promise<{ outcome: string; posted: number; amount?: number }> {
  const { data, error } = await client.rpc('cod_post_remittance', {
    p_remittance_id: remittanceId,
  })
  if (error) throw error
  return data as unknown as { outcome: string; posted: number; amount?: number }
}

export async function discardBatch(
  remittanceId: string,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('cod_discard_remittance', {
    p_remittance_id: remittanceId,
  })
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export interface RtsReport {
  sinceDays: number
  count: number
  cost: number
  valueReturned: number
  restockedCount: number
  byReason: { reason: string; count: number; cost: number }[]
  byProvince: { province: string; count: number; cost: number }[]
  repeatOffenders: {
    phoneDigits: string
    orders: number
    delivered: number
    rts: number
    rtsRateBps: number
    blockCod: boolean
    note: string | null
  }[]
}

export const RTS_REASONS = [
  'buyer_unreachable',
  'buyer_refused',
  'wrong_address',
  'buyer_cancelled',
  'damaged',
  'other',
] as const

export type RtsReason = (typeof RTS_REASONS)[number]

export async function fetchRtsReport(
  tenantId: string,
  days = 90,
  client: SelldClient = getSupabase(),
): Promise<RtsReport> {
  const { data, error } = await client.rpc('rts_report', { p_tenant_id: tenantId, p_days: days })
  if (error) throw error
  return data as unknown as RtsReport
}

export async function recordRts(
  input: {
    orderId: string
    reason: RtsReason
    restock: boolean
    returnCost: number | null
    note: string | null
  },
  client: SelldClient = getSupabase(),
): Promise<{ outcome: string; restocked: boolean; unitsReturned: number; costCentavos: number }> {
  const { data, error } = await client.rpc('record_rts', {
    p_order_id: input.orderId,
    p_reason: input.reason,
    p_restock: input.restock,
    // Both optional in SQL, and absent means the same thing as null: use the
    // outbound cost, and say nothing.
    ...(input.returnCost === null ? {} : { p_return_cost: input.returnCost }),
    ...(input.note === null ? {} : { p_note: input.note }),
  })
  if (error) throw error
  return data as unknown as {
    outcome: string
    restocked: boolean
    unitsReturned: number
    costCentavos: number
  }
}

export async function setBuyerFlag(
  tenantId: string,
  phone: string,
  blockCod: boolean,
  client: SelldClient = getSupabase(),
): Promise<void> {
  const { error } = await client.rpc('buyer_risk_set_flag', {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_block_cod: blockCod,
  })
  if (error) throw error
}

/**
 * Turn a failure into something a seller can act on.
 *
 * Both halves matter. A parse failure is about *their file* — wrong column, wrong
 * export, wrong courier picked — and the fix is on their side. A database failure
 * is about their account.
 *
 * The database branch reads the message through `errorMessage()` and not through an
 * `instanceof Error` guard: on the ordinary PostgREST path, postgrest-js returns a
 * **plain object**, so an `instanceof` check in front of a matcher returns the
 * fallback for every database failure there is. That shipped twice already.
 */
export function describeCodError(error: unknown): string {
  if (error instanceof StatementError) {
    switch (error.code) {
      case 'no_header':
        return 'cod.errorNoHeader'
      case 'no_waybill_column':
        return 'cod.errorNoWaybillColumn'
      case 'no_amount_column':
        return 'cod.errorNoAmountColumn'
      case 'no_rows':
      case 'empty_file':
        return 'cod.errorEmpty'
    }
  }
  if (error instanceof XlsxError) return 'cod.errorNotASpreadsheet'

  const message = errorMessage(error)
  if (message.includes('too many rows')) return 'cod.errorTooManyRows'
  if (message.includes('Not allowed')) return 'cod.errorNotAllowed'
  if (message.includes('already posted') || message.includes('discarded')) {
    return 'cod.errorAlreadyPosted'
  }
  // A courier does not issue the same payout reference twice; a re-import is
  // almost always the same file a second time.
  if (message.includes('cod_remittances_reference_idx')) return 'cod.errorDuplicateStatement'
  return 'cod.errorUnknown'
}
