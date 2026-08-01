import { normalizePhPhone, parsePhPhone } from '@/lib/phone/ph-phone'
import { clearSnapshots } from '@/lib/offline/offline-cache'
import { getSupabase } from '@/lib/supabase/client'

/**
 * Auth operations.
 *
 * Two entry paths, because sellers split roughly evenly:
 *
 *  - **Email OTP** (6-digit code, not a magic link). Magic links break constantly
 *    on mobile: the link opens in the in-app browser of whichever mail client they
 *    use, which is a different session from the browser they signed up in, so the
 *    session lands in the wrong place. A code they retype always works.
 *  - **Phone OTP**, which is what most sellers actually prefer — many run their
 *    business entirely from a phone number and rarely open email.
 */

export type OtpChannel = 'email' | 'phone'

export interface RequestOtpResult {
  channel: OtpChannel
  /** Normalised destination, safe to display back ("code sent to 0917 …"). */
  destination: string
}

export class AuthValidationError extends Error {
  readonly field: 'email' | 'phone' | 'code' | 'password'
  constructor(field: 'email' | 'phone' | 'code' | 'password', message: string) {
    super(message)
    this.name = 'AuthValidationError'
    this.field = field
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isValidEmail(raw: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(raw))
}

/**
 * Shortest password we will set or accept.
 *
 * Eight, not the six the Supabase project will tolerate: the floor a seller
 * meets is the floor most of them will sit exactly on, and this account can read
 * every customer's name, phone and address.
 */
export const MIN_PASSWORD_LENGTH = 8

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH
}

/**
 * Email + password.
 *
 * Added alongside the codes rather than replacing them. A seller who signs in
 * from the same phone every day would rather type a password they know than
 * fetch a code from an inbox they do not open; a seller who has forgotten it —
 * and phone-first sellers, who often have no working email at all — still have
 * the code path, which needs nothing remembered.
 */
export async function signInWithPassword(rawEmail: string, password: string): Promise<void> {
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) {
    throw new AuthValidationError('email', 'Enter a valid email address.')
  }
  if (password === '') {
    throw new AuthValidationError('password', 'Enter your password.')
  }

  const { error } = await getSupabase().auth.signInWithPassword({ email, password })
  if (error) throw error
}

/**
 * Start a password reset — by code, not by link.
 *
 * `resetPasswordForEmail` would email a link back to the app's origin, and the
 * comment at the top of this file is the reason not to: it opens in whichever
 * mail client's in-app browser the seller uses, which is a different session
 * from the one they are sitting in. The recovery template on this project sends
 * `{{ .Token }}`, so the same six digits and the same screen serve both flows.
 */
export async function requestPasswordReset(rawEmail: string): Promise<RequestOtpResult> {
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) {
    throw new AuthValidationError('email', 'Enter a valid email address.')
  }

  // `shouldCreateUser: false` — a reset must not quietly create an account for a
  // typo'd address, which would then be a real account nobody owns.
  const { error } = await getSupabase().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })
  if (error) throw error
  return { channel: 'email', destination: email }
}

/**
 * Finish a reset: prove the code, then set the password.
 *
 * Two calls, in this order, and the order is the security property —
 * `updateUser` changes the password of whoever the current session belongs to,
 * so it is only safe once `verifyOtp` has established that the session belongs
 * to the person who read the email.
 */
export async function completePasswordReset(input: {
  email: string
  code: string
  password: string
}): Promise<void> {
  const code = input.code.trim()
  if (!isValidOtpCode(code)) {
    throw new AuthValidationError('code', 'Enter the 6-digit code.')
  }
  if (!isValidPassword(input.password)) {
    throw new AuthValidationError(
      'password',
      `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    )
  }

  const supabase = getSupabase()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: normalizeEmail(input.email),
    token: code,
    type: 'email',
  })
  if (verifyError) throw verifyError

  const { error } = await supabase.auth.updateUser({ password: input.password })
  if (error) throw error
}

/** Send a 6-digit code to an email address. */
export async function requestEmailOtp(
  rawEmail: string,
  options: { fullName?: string } = {},
): Promise<RequestOtpResult> {
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) {
    throw new AuthValidationError('email', 'Enter a valid email address.')
  }

  const { error } = await getSupabase().auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      // Feeds handle_new_auth_user(), which populates the profile row.
      // Spread conditionally: exactOptionalPropertyTypes rejects an explicit
      // `undefined` for an optional property.
      ...(options.fullName ? { data: { full_name: options.fullName.trim() } } : {}),
    },
  })
  if (error) throw error

  return { channel: 'email', destination: email }
}

/**
 * Send a 6-digit code by SMS.
 *
 * Rejects landlines before spending an SMS credit — a landline can never receive
 * one, and the send would be billed anyway.
 */
export async function requestPhoneOtp(
  rawPhone: string,
  options: { fullName?: string } = {},
): Promise<RequestOtpResult> {
  const parsed = parsePhPhone(rawPhone)
  if (!parsed) {
    throw new AuthValidationError('phone', 'Enter a valid Philippine mobile number.')
  }
  if (parsed.kind !== 'mobile') {
    throw new AuthValidationError('phone', 'Only mobile numbers can receive a code.')
  }

  const { error } = await getSupabase().auth.signInWithOtp({
    phone: parsed.e164,
    options: {
      shouldCreateUser: true,
      data: {
        phone: parsed.e164,
        ...(options.fullName ? { full_name: options.fullName.trim() } : {}),
      },
    },
  })
  if (error) throw error

  return { channel: 'phone', destination: parsed.national }
}

export function isValidOtpCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim())
}

/** Exchange a 6-digit code for a session. */
export async function verifyOtp(input: {
  channel: OtpChannel
  destination: string
  code: string
}): Promise<void> {
  const code = input.code.trim()
  if (!isValidOtpCode(code)) {
    throw new AuthValidationError('code', 'Enter the 6-digit code.')
  }

  const supabase = getSupabase()

  if (input.channel === 'email') {
    const { error } = await supabase.auth.verifyOtp({
      email: normalizeEmail(input.destination),
      token: code,
      type: 'email',
    })
    if (error) throw error
    return
  }

  const phone = normalizePhPhone(input.destination)
  if (!phone) throw new AuthValidationError('phone', 'Enter a valid Philippine mobile number.')

  const { error } = await supabase.auth.verifyOtp({ phone, token: code, type: 'sms' })
  if (error) throw error
}

/**
 * Sign out, and take the offline cache with it.
 *
 * Cleared *before* the network call rather than after: a packer handing the phone
 * back is the whole scenario, and if `signOut()` throws on a dead connection the
 * one thing that must still have happened is that the customer list is gone from
 * this device. The session token is cleared locally by supabase-js regardless.
 */
export async function signOut(): Promise<void> {
  clearSnapshots()
  const { error } = await getSupabase().auth.signOut()
  if (error) throw error
}
