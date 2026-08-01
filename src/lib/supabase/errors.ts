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

/**
 * The `HINT` a `raise ... using hint = '…'` attached, when there is one.
 *
 * The machine-readable half of a database error. `message` is written for a
 * person and gets rewritten the moment somebody improves the wording; a hint like
 * `plan_limit_products` is a contract between the migration and the screen, and
 * matching on it is what stops a copy-edit in SQL from silently turning a specific
 * explanation into "please try again".
 *
 * PostgREST forwards it as its own JSON field, so it is *not* inside `message` —
 * a matcher that only reads `errorMessage()` never sees it. That is a quiet
 * failure: the code compiles, the test passes if the test builds the object
 * wrongly, and the seller gets the fallback forever.
 */
export function errorHint(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const hint = (error as { hint?: unknown }).hint
  return typeof hint === 'string' ? hint : ''
}

/** The Postgres/PostgREST code (`23505`, `42501`, `PGRST116`, …) when there is one. */
export function errorCode(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}
