import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  AuthValidationError,
  completePasswordReset,
  isValidPassword,
  MIN_PASSWORD_LENGTH,
  requestPasswordReset,
  signInWithPassword,
} from '@/features/auth/auth-api'

/**
 * Password sign-in and reset-by-code.
 *
 * The reset is two calls in a fixed order — prove the code, *then* set the
 * password — and that order is the whole security property: `updateUser`
 * changes the password of whoever the current session belongs to, so running it
 * first would let anyone who knows an email address overwrite the password on
 * whatever session happened to be open. These tests assert the order, not just
 * the outcome.
 */

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({ getSupabase: () => ({ auth }) }))

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset()
  auth.signInWithPassword.mockResolvedValue({ error: null })
  auth.signInWithOtp.mockResolvedValue({ error: null })
  auth.verifyOtp.mockResolvedValue({ error: null })
  auth.updateUser.mockResolvedValue({ error: null })
})

describe('signInWithPassword', () => {
  test('normalises the email the way the OTP path does', async () => {
    await signInWithPassword('  Rhea@Example.PH ', 'correct horse')
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'rhea@example.ph',
      password: 'correct horse',
    })
  })

  test('refuses an address that is not one, before touching the network', async () => {
    await expect(signInWithPassword('not-an-email', 'whatever')).rejects.toBeInstanceOf(
      AuthValidationError,
    )
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  test('refuses an empty password rather than asking the server about it', async () => {
    await expect(signInWithPassword('rhea@example.ph', '')).rejects.toBeInstanceOf(
      AuthValidationError,
    )
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })
})

describe('requestPasswordReset', () => {
  test('never creates an account — a typo must not mint a real one nobody owns', async () => {
    await requestPasswordReset('rhea@example.ph')
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'rhea@example.ph',
      options: { shouldCreateUser: false },
    })
  })
})

describe('completePasswordReset', () => {
  test('proves the code before it sets the password', async () => {
    const order: string[] = []
    auth.verifyOtp.mockImplementation(() => {
      order.push('verify')
      return Promise.resolve({ error: null })
    })
    auth.updateUser.mockImplementation(() => {
      order.push('update')
      return Promise.resolve({ error: null })
    })

    await completePasswordReset({
      email: 'rhea@example.ph',
      code: '123456',
      password: 'a-long-enough-one',
    })

    expect(order).toEqual(['verify', 'update'])
  })

  test('does not set a password when the code is refused', async () => {
    auth.verifyOtp.mockResolvedValue({ error: { message: 'Token has expired' } })

    await expect(
      completePasswordReset({
        email: 'rhea@example.ph',
        code: '123456',
        password: 'a-long-enough-one',
      }),
    ).rejects.toBeTruthy()

    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  test('refuses a short password without spending the code on it', async () => {
    await expect(
      completePasswordReset({ email: 'rhea@example.ph', code: '123456', password: 'short' }),
    ).rejects.toBeInstanceOf(AuthValidationError)
    expect(auth.verifyOtp).not.toHaveBeenCalled()
  })

  test('refuses a malformed code without spending a round trip', async () => {
    await expect(
      completePasswordReset({ email: 'rhea@example.ph', code: '12', password: 'a-long-enough-one' }),
    ).rejects.toBeInstanceOf(AuthValidationError)
    expect(auth.verifyOtp).not.toHaveBeenCalled()
  })
})

describe('isValidPassword', () => {
  test('holds the floor at the documented length', () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false)
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true)
  })
})
