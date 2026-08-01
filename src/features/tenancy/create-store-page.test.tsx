import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe as suite, expect, test, vi } from 'vitest'

import { initI18n } from '@/lib/i18n'

import { CreateStorePage } from '@/features/tenancy/create-store-page'

/**
 * Regressions found on a real phone, on the live deployment.
 *
 * A seller typed "phase" into the store address, the keyboard added a space
 * after the word, and the screen answered with a red validation error and the
 * proposed address `phase .selld.vercel.app` — a hostname with a space in it.
 * Nothing was broken server-side; the field simply did not normalise what a
 * phone keyboard produces, which is hard rule 4 (mobile-first) failing at the
 * very first field a new seller touches.
 */

const createTenant = vi.hoisted(() => vi.fn())

vi.mock('@/features/tenancy/tenancy-api', () => ({ createTenant }))
vi.mock('@/features/tenancy/use-tenant', () => ({
  useTenant: () => ({ refetch: vi.fn(), setActiveTenant: vi.fn() }),
}))
vi.mock('@/features/auth/auth-api', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/env', () => ({ env: { rootDomain: 'selld.vercel.app' } }))

const slugField = () => screen.getByLabelText(/store address/i)

beforeEach(() => {
  initI18n('en')
  createTenant.mockReset()
})

suite('the store address field', () => {
  test('turns the space a phone keyboard adds into a hyphen', async () => {
    const user = userEvent.setup()
    render(<CreateStorePage />)

    await user.type(slugField(), 'davao biryani')

    expect(slugField()).toHaveValue('davao-biryani')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a trailing space does not become an error mid-word', async () => {
    const user = userEvent.setup()
    render(<CreateStorePage />)

    // Exactly the screenshot: one word, then the keyboard's space.
    await user.type(slugField(), 'phase ')

    expect(slugField()).toHaveValue('phase-')
    // `phase-` is not yet valid, but it must not be shown as an address.
    expect(screen.queryByText(/phase.*\.selld\.vercel\.app/)).toBeNull()
  })

  test('a hyphen can still be typed — it must survive the keystroke', async () => {
    const user = userEvent.setup()
    render(<CreateStorePage />)

    await user.type(slugField(), 'davao-')
    expect(slugField()).toHaveValue('davao-')

    await user.type(slugField(), 'biryani')
    expect(slugField()).toHaveValue('davao-biryani')
  })

  test('never proposes an address that could not resolve', async () => {
    const user = userEvent.setup()
    render(<CreateStorePage />)

    await user.type(slugField(), 'ab')
    // Too short to be valid, so no address is offered.
    expect(screen.queryByText(/\.selld\.vercel\.app/)).toBeNull()

    await user.type(slugField(), 'c')
    expect(screen.getByText('abc.selld.vercel.app')).toBeInTheDocument()
  })
})

suite('when the database refuses', () => {
  test('a taken address is named, not hidden behind "something went wrong"', async () => {
    // A PostgREST error on the ordinary path is a PLAIN OBJECT, not an Error.
    // Building it any other way makes this test pass against the bug.
    createTenant.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "tenants_slug_key"',
      details: null,
      hint: null,
    })

    const user = userEvent.setup()
    render(<CreateStorePage />)

    await user.type(screen.getByLabelText(/store name/i), 'Davao Biryani')
    await user.type(slugField(), 'davao-biryani')
    await user.click(screen.getByRole('button', { name: /create store/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/taken|nakuha na|ginagamit/i)
    expect(alert).not.toHaveTextContent(/something went wrong/i)
  })
})
