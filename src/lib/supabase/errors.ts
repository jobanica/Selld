/**
 * Reading a message off whatever PostgREST rejected a write with.
 *
 * This exists because of a trap that is invisible in tests and total in the
 * browser. `postgrest-js` only constructs its `PostgrestError` class — which does
 * extend `Error` — when the caller opted into `.throwOnError()`. On the ordinary
 * `const { data, error } = await client.from(…)` path it does
 * `error = JSON.parse(body)` and hands back a **plain object**:
 *
 *     { code: '23505', details: null, hint: null,
 *       message: 'duplicate key value violates unique constraint "…_city_idx"' }
 *
 * So `throw error` throws a non-Error, and every `if (!(error instanceof Error))`
 * guard in front of a message matcher returns its fallback for *all* database
 * failures. The symptom is not a crash: the seller gets "Could not save that.
 * Please try again." for a duplicate they must instead go and remove, and retries
 * for as long as they are willing to. A unit test that builds the error as
 * `new Error(realMessage)` passes happily, which is how this survived being
 * written twice.
 *
 * Use this instead of touching `.message` behind an `instanceof` check.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error === null || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/** The Postgres/PostgREST code (`23505`, `42501`, `PGRST116`, …) when there is one. */
export function errorCode(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}
