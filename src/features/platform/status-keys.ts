/**
 * Subscription status -> translation key.
 *
 * Its own module because `react-refresh/only-export-components` requires a file
 * to export components *or* other things — the same rule the provider/context/hook
 * split follows.
 *
 * A literal map rather than a template literal: `t(`billing.status.${status}`)`
 * compiles and loses the compile-time check that the key exists, so a status the
 * UI has not been taught about renders as a raw `past_due` on somebody's phone.
 * Adding a status has to touch this file, which is the point.
 */
export const STATUS_KEYS = {
  trialing: 'billing.status.trialing',
  active: 'billing.status.active',
  past_due: 'billing.status.past_due',
  restricted: 'billing.status.restricted',
  cancelled: 'billing.status.cancelled',
} as const

export type StatusKey = (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS]

export function statusKey(status: string | null): StatusKey {
  return STATUS_KEYS[status as keyof typeof STATUS_KEYS] ?? 'billing.status.cancelled'
}
