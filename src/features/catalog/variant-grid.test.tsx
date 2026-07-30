import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { initI18n } from '@/lib/i18n'
import { pesos } from '@/lib/money'

import { VariantGrid } from './variant-grid'
import { generateVariantMatrix, type DraftVariant } from './variant-matrix'

/** Controlled harness, matching how the product form drives the grid. */
function Harness({ initial }: { initial: DraftVariant[] }) {
  const [variants, setVariants] = useState(initial)
  const [prefix, setPrefix] = useState('')
  return (
    <VariantGrid
      variants={variants}
      onChange={setVariants}
      skuPrefix={prefix}
      onSkuPrefixChange={setPrefix}
    />
  )
}

const SIZE_MATRIX = generateVariantMatrix(
  [{ name: 'Size', values: [{ value: 'S' }, { value: 'M' }, { value: 'L' }] }],
  { defaultPrice: pesos('499') },
)

/** jsdom has no layout, so both the table and the card list are "present". */
function priceInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText(/^Price /) as HTMLInputElement[]
}

describe('VariantGrid bulk price', () => {
  beforeEach(() => {
    initI18n('en')
  })

  /**
   * Regression guard.
   *
   * The price inputs were originally uncontrolled (`defaultValue`), so "apply to
   * all" updated the underlying state and the row badges but left every input
   * showing the old number. It saved the right price and looked completely broken —
   * which is worse than failing, because the seller cannot tell.
   */
  it('propagates a bulk price to every price input', async () => {
    const user = userEvent.setup()
    render(<Harness initial={SIZE_MATRIX} />)

    for (const input of priceInputs()) {
      expect(input.value).toBe('499.00')
    }

    await user.clear(screen.getByLabelText('Apply to all'))
    await user.type(screen.getByLabelText('Apply to all'), '549')

    for (const input of priceInputs()) {
      expect(input.value).toBe('549.00')
    }
  })

  it('does not reformat while the seller is still typing', async () => {
    const user = userEvent.setup()
    render(<Harness initial={SIZE_MATRIX} />)

    const first = priceInputs()[0]!
    await user.clear(first)
    await user.type(first, '1499')

    // Not "14.99", and not "1499.00" — exactly what was typed.
    expect(first.value).toBe('1499')
  })

  it('keeps an unparseable intermediate state instead of clobbering it', async () => {
    const user = userEvent.setup()
    render(<Harness initial={SIZE_MATRIX} />)

    const first = priceInputs()[0]!
    await user.clear(first)
    await user.type(first, '12.')

    expect(first.value).toBe('12.')
  })

  it('auto-fills SKUs for every row from the prefix', async () => {
    const user = userEvent.setup()
    render(<Harness initial={SIZE_MATRIX} />)

    await user.type(screen.getByLabelText('Auto-fill SKUs'), 'RF-TEE')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)

    const skus = (screen.getAllByLabelText(/^SKU /) as HTMLInputElement[]).map(
      (input) => input.value,
    )
    expect(skus).toContain('RF-TEE-S')
    expect(skus).toContain('RF-TEE-M')
    expect(skus).toContain('RF-TEE-L')
  })

  it('renders every generated combination and reports the count', () => {
    render(<Harness initial={SIZE_MATRIX} />)
    expect(screen.getByText(/3 variants generated/)).toBeInTheDocument()
    // 3 rows, each rendered in both the table and the card list (jsdom has no
    // layout, so neither is hidden).
    expect(priceInputs()).toHaveLength(6)
    for (const label of ['S', 'M', 'L']) {
      expect(screen.getAllByLabelText(`Price ${label}`)).toHaveLength(2)
    }
  })

  it('renders nothing when there are no variants', () => {
    const { container } = render(<Harness initial={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
