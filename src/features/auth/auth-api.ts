import { normalizePhPhone, parsePhPhone } from '@/lib/phone/ph-phone'
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
  readonly field: 'email' | 'phone' | 'code'
  constructor(field: 'email' | 'phone' | 'code', message: string) {
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

export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut()
  if (error) throw error
}
