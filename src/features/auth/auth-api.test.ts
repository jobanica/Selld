import { describe, expect, it, vi } from 'vitest'

import {
  AuthValidationError,
  isValidEmail,
  isValidOtpCode,
  normalizeEmail,
  requestEmailOtp,
  requestPhoneOtp,
  verifyOtp,
} from './auth-api'

// The Supabase client is a network boundary; stub it so these tests assert what
// we *send*, which is where the bugs actually live.
const signInWithOtp = vi.fn().mockResolvedValue({ error: null })
const verifyOtpMock = vi.fn().mockResolvedValue({ error: null })

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: () => ({ auth: { signInWithOtp, verifyOtp: verifyOtpMock } }),
}))

describe('email validation', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeEmail('  Rhea@Example.PH ')).toBe('rhea@example.ph')
  })

  it('accepts real addresses and rejects junk', () => {
    expect(isValidEmail('rhea@example.ph')).toBe(true)
    expect(isValidEmail('rhea+finds@example.co.uk')).toBe(true)
    expect(isValidEmail('rhea@example')).toBe(false)
    expect(isValidEmail('rhea @example.ph')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })
})

describe('requestEmailOtp()', () => {
  it('sends a normalised address', async () => {
    signInWithOtp.mockClear()
    await requestEmailOtp('  Rhea@Example.PH ')
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'rhea@example.ph',
      options: { shouldCreateUser: true },
    })
  })

  it('passes full_name through for the profile trigger', async () => {
    signInWithOtp.mockClear()
    await requestEmailOtp('rhea@example.ph', { fullName: '  Rhea Santos ' })
    expect(signInWithOtp.mock.calls[0]![0].options.data).toEqual({ full_name: 'Rhea Santos' })
  })

  it('rejects an invalid address before hitting the network', async () => {
    signInWithOtp.mockClear()
    await expect(requestEmailOtp('nope')).rejects.toThrow(AuthValidationError)
    expect(signInWithOtp).not.toHaveBeenCalled()
  })
})

describe('requestPhoneOtp()', () => {
  it('normalises the number to E.164 before sending', async () => {
    signInWithOtp.mockClear()
    const result = await requestPhoneOtp('0917 123 4567')
    expect(signInWithOtp.mock.calls[0]![0].phone).toBe('+639171234567')
    // Echoed back in the local format a Filipino reads.
    expect(result.destination).toBe('0917 123 4567')
  })

  it('accepts every input form a seller might type', async () => {
    for (const input of ['09171234567', '+63 917 123 4567', '639171234567', '9171234567']) {
      signInWithOtp.mockClear()
      await requestPhoneOtp(input)
      expect(signInWithOtp.mock.calls[0]![0].phone, input).toBe('+639171234567')
    }
  })

  it('refuses a landline WITHOUT spending an SMS credit', async () => {
    signInWithOtp.mockClear()
    await expect(requestPhoneOtp('(02) 8123 4567')).rejects.toThrow(/mobile/i)
    // The point of the check: a landline send would be billed and never arrive.
    expect(signInWithOtp).not.toHaveBeenCalled()
  })

  it('refuses an unparseable number without calling out', async () => {
    signInWithOtp.mockClear()
    await expect(requestPhoneOtp('12345')).rejects.toThrow(AuthValidationError)
    expect(signInWithOtp).not.toHaveBeenCalled()
  })
})

describe('verifyOtp()', () => {
  it('validates the code shape before calling out', () => {
    expect(isValidOtpCode('123456')).toBe(true)
    expect(isValidOtpCode(' 123456 ')).toBe(true)
    expect(isValidOtpCode('12345')).toBe(false)
    expect(isValidOtpCode('12345a')).toBe(false)
  })

  it('verifies an email code with type "email"', async () => {
    verifyOtpMock.mockClear()
    await verifyOtp({ channel: 'email', destination: 'Rhea@Example.PH', code: '123456' })
    expect(verifyOtpMock).toHaveBeenCalledWith({
      email: 'rhea@example.ph',
      token: '123456',
      type: 'email',
    })
  })

  it('verifies a phone code with type "sms" and a normalised number', async () => {
    verifyOtpMock.mockClear()
    await verifyOtp({ channel: 'phone', destination: '0917 123 4567', code: '654321' })
    expect(verifyOtpMock).toHaveBeenCalledWith({
      phone: '+639171234567',
      token: '654321',
      type: 'sms',
    })
  })

  it('rejects a malformed code without calling out', async () => {
    verifyOtpMock.mockClear()
    await expect(
      verifyOtp({ channel: 'email', destination: 'rhea@example.ph', code: '12' }),
    ).rejects.toThrow(AuthValidationError)
    expect(verifyOtpMock).not.toHaveBeenCalled()
  })
})
