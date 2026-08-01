import { describe, expect, it } from 'vitest'

import { describeBillingError, describePlanLimitError } from './billing-api'

/**
 * Both matchers are fed a **plain object**, not an `Error`.
 *
 * That is what postgrest-js actually returns on the ordinary
 * `const { error } = await client.rpc(...)` path — it does `JSON.parse(body)` and
 * hands back the object, only constructing its `PostgrestError` class under
 * `.throwOnError()`. A test that builds `new Error(message)` passes happily
 * against a matcher that returns the fallback for every real database failure,
 * which is exactly how `describeStockError` and `describeShippingError` shipped
 * broken twice. See CLAUDE.md.
 */
const pgError = (message: string, hint?: string) => ({
  message,
  details: null,
  hint: hint ?? null,
  code: '23514',
})

describe('describePlanLimitError', () => {
  it('names the limit that was hit, from a plain PostgREST error object', () => {
    expect(describePlanLimitError(pgError('Your plan allows 20 products', 'plan_limit_products')))
      .toBe('billing.limitProducts')
    expect(describePlanLimitError(pgError('Your plan allows 1 users', 'plan_limit_users'))).toBe(
      'billing.limitUsers',
    )
    expect(
      describePlanLimitError(pgError('Your plan allows 50 orders a month', 'plan_limit_orders')),
    ).toBe('billing.limitOrders')
  })

  it('names the feature a plan does not carry', () => {
    expect(
      describePlanLimitError(pgError('Your plan does not include live', 'plan_feature_live')),
    ).toBe('billing.featureLive')
    expect(
      describePlanLimitError(
        pgError('Your plan does not include marketplaces', 'plan_feature_marketplaces'),
      ),
    ).toBe('billing.featureMarketplaces')
  })

  it('recognises a restricted subscription', () => {
    expect(
      describePlanLimitError(
        pgError('Your subscription is not active, so new products cannot be added', 'billing_restricted'),
      ),
    ).toBe('billing.restricted')
  })

  it('returns null for anything that is not a plan limit', () => {
    // The caller renders its own error when this is null, so a false positive
    // here would relabel an unrelated failure as a billing problem and send the
    // seller to a screen that cannot help them.
    expect(describePlanLimitError(pgError('duplicate key value violates unique constraint'))).toBe(
      null,
    )
    expect(describePlanLimitError(null)).toBe(null)
  })
})

describe('describeBillingError', () => {
  it('explains a refused downgrade in terms of what to do about it', () => {
    expect(
      describeBillingError(pgError('You have 40 products and Starter allows 20', 'downgrade_products')),
    ).toBe('billing.errorDowngradeProducts')
    expect(
      describeBillingError(pgError('You have 5 users and Starter allows 3', 'downgrade_users')),
    ).toBe('billing.errorDowngradeUsers')
  })

  it('falls back rather than leaking a database message to the seller', () => {
    expect(describeBillingError(pgError('relation "subscriptions" does not exist'))).toBe(
      'billing.errorUnknown',
    )
  })
})
