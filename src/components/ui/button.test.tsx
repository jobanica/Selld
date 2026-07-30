import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { Button } from './button'

/**
 * Regression guard.
 *
 * Button originally did not forward its ref. Every unit test still passed —
 * jsdom performs no layout — but in a real browser every Radix `asChild` trigger
 * silently broke: the popper never measured its anchor and rendered off-screen at
 * `translate(0, -200%)`, so dropdowns looked like they simply did not open.
 *
 * These tests fail fast if the ref is ever dropped again, which is easy to do
 * when copying current shadcn/ui source (written for React 19, where `ref` is a
 * plain prop) into this React 18 codebase.
 */
describe('Button ref forwarding', () => {
  it('forwards its ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>Book parcels</Button>)

    expect(ref.current).not.toBeNull()
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Book parcels' }))
  })

  it('forwards its ref through asChild to the slotted element', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button asChild ref={ref}>
        <a href="/orders">Orders</a>
      </Button>,
    )

    // asChild renders the child, so the ref must land on the anchor — this is the
    // exact path Radix triggers use.
    expect(ref.current).not.toBeNull()
    expect(ref.current?.tagName).toBe('A')
  })

  it('still renders variants and merges classes', () => {
    render(
      <Button variant="outline" size="sm" className="custom">
        Cancel
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Cancel' })
    expect(button.className).toContain('custom')
    expect(button.className).toContain('border')
  })

  it('keeps a 44px minimum touch target on the default size', () => {
    render(<Button>Confirm</Button>)
    // h-11 == 2.75rem == 44px. Sellers tap this one-handed holding a parcel.
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain('h-11')
  })
})
