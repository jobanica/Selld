import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PH_ADDRESS, isAddressComplete, type PhAddressValue } from '@/features/address/ph-address'
import { PhAddressPicker } from '@/features/address/ph-address-picker'
import {
  CATEGORY_PRESETS,
  categoriesForPresets,
  isPresetKey,
  presetLabel,
} from '@/features/onboarding/category-presets'
import { LogoValidationError, validateLogoFile } from '@/features/onboarding/onboarding-api'
import { initI18n } from '@/lib/i18n'
import type { Barangay, City, Province, Region } from '@/lib/psgc'

// PSGC data comes from the database; stub the query layer so these tests assert
// the cascade's behaviour rather than re-testing SQL.
const listRegions = vi.fn<() => Promise<Region[]>>()
const listProvinces = vi.fn<(regionCode: string) => Promise<Province[]>>()
const listCities = vi.fn<(location: unknown) => Promise<City[]>>()
const listBarangays = vi.fn<(cityCode: string) => Promise<Barangay[]>>()

vi.mock('@/lib/psgc', () => ({
  listRegions: () => listRegions(),
  listProvinces: (regionCode: string) => listProvinces(regionCode),
  listCities: (location: unknown) => listCities(location),
  listBarangays: (cityCode: string) => listBarangays(cityCode),
  PSGC_QUERY_OPTIONS: { staleTime: Number.POSITIVE_INFINITY },
}))

const DAVAO_REGION: Region = {
  code: '110000000',
  name: 'Davao Region',
  regionNumeral: 'Region XI',
  islandGroup: 'mindanao',
}
const NCR: Region = {
  code: '130000000',
  name: 'National Capital Region',
  regionNumeral: 'NCR',
  islandGroup: 'luzon',
}
const DAVAO_SUR: Province = {
  code: '112400000',
  name: 'Davao del Sur',
  regionCode: '110000000',
}
const DAVAO_CITY: City = {
  code: '112402000',
  name: 'City of Davao',
  displayName: 'Davao City',
  isCity: true,
  isCapital: false,
  provinceCode: '112400000',
  regionCode: '110000000',
}
const QUEZON_CITY: City = {
  code: '137404000',
  name: 'Quezon City',
  displayName: 'Quezon City',
  isCity: true,
  isCapital: false,
  provinceCode: null,
  regionCode: '130000000',
}
const BUHANGIN: Barangay = {
  code: '112402014',
  name: 'Buhangin',
  cityCode: '112402000',
  subMunicipalityCode: null,
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('isAddressComplete()', () => {
  it('needs region, city, barangay and a street', () => {
    expect(isAddressComplete(EMPTY_PH_ADDRESS)).toBe(false)
    expect(
      isAddressComplete({
        ...EMPTY_PH_ADDRESS,
        regionCode: '110000000',
        cityCode: '112402000',
        barangayCode: '112402014',
        street: 'Mahogany St.',
      }),
    ).toBe(true)
  })

  it('does NOT require a province — NCR addresses have none', () => {
    expect(
      isAddressComplete({
        ...EMPTY_PH_ADDRESS,
        regionCode: '130000000',
        provinceCode: null,
        cityCode: '137404000',
        barangayCode: '137404001',
        street: 'Katipunan Ave.',
      }),
    ).toBe(true)
  })

  it('rejects a whitespace-only street', () => {
    expect(
      isAddressComplete({
        ...EMPTY_PH_ADDRESS,
        regionCode: '1',
        cityCode: '2',
        barangayCode: '3',
        street: '   ',
      }),
    ).toBe(false)
  })
})

/** Stateful harness, so the picker behaves as it does in a real form. */
function AddressHarness({ onValue }: { onValue: (value: PhAddressValue) => void }) {
  const [value, setValue] = useState<PhAddressValue>(EMPTY_PH_ADDRESS)
  return (
    <Wrapper>
      <PhAddressPicker
        value={value}
        onChange={(next) => {
          setValue(next)
          onValue(next)
        }}
      />
    </Wrapper>
  )
}

describe('PhAddressPicker', () => {
  beforeEach(() => {
    initI18n('en')
    listRegions.mockReset()
    listProvinces.mockReset()
    listCities.mockReset()
    listBarangays.mockReset()
    listRegions.mockResolvedValue([DAVAO_REGION, NCR])
    listProvinces.mockResolvedValue([])
    listCities.mockResolvedValue([])
    listBarangays.mockResolvedValue([])
  })

  function renderPicker() {
    let latest: PhAddressValue = EMPTY_PH_ADDRESS
    render(<AddressHarness onValue={(value) => (latest = value)} />)
    return { get: () => latest }
  }

  /** Options arrive asynchronously, so wait for the option rather than the label. */
  async function pickRegion(user: ReturnType<typeof userEvent.setup>, code: string, name: RegExp) {
    await screen.findByRole('option', { name })
    await user.selectOptions(screen.getByLabelText('Region'), code)
  }

  it('shows a province step for a region that has provinces', async () => {
    const user = userEvent.setup()
    listProvinces.mockResolvedValue([DAVAO_SUR])
    listCities.mockResolvedValue([DAVAO_CITY])
    const picker = renderPicker()

    await pickRegion(user, '110000000', /Davao Region/)

    expect(await screen.findByLabelText('Province')).toBeInTheDocument()
    expect(picker.get().regionCode).toBe('110000000')
  })

  /**
   * The structural case this component exists for: NCR has no provinces, so the
   * cascade must go region -> city directly rather than stalling on an empty
   * province list.
   */
  it('SKIPS the province step for NCR and goes straight to city', async () => {
    const user = userEvent.setup()
    listProvinces.mockResolvedValue([]) // NCR
    listCities.mockResolvedValue([QUEZON_CITY])
    renderPicker()

    await pickRegion(user, '130000000', /National Capital Region/)

    // The city select becomes usable without any province being chosen.
    expect(await screen.findByRole('option', { name: 'Quezon City' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Province')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/City or municipality/)).toBeEnabled()
  })

  it('renders the colloquial city name, not the PSA name', async () => {
    const user = userEvent.setup()
    listProvinces.mockResolvedValue([DAVAO_SUR])
    listCities.mockResolvedValue([DAVAO_CITY])
    renderPicker()

    await pickRegion(user, '110000000', /Davao Region/)
    await screen.findByLabelText('Province')
    await user.selectOptions(screen.getByLabelText('Province'), '112400000')

    // "Davao City", never "City of Davao".
    expect(await screen.findByRole('option', { name: 'Davao City' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'City of Davao' })).not.toBeInTheDocument()
  })

  it('clears everything below a level when that level changes', async () => {
    const user = userEvent.setup()
    listProvinces.mockResolvedValue([DAVAO_SUR])
    listCities.mockResolvedValue([DAVAO_CITY])
    listBarangays.mockResolvedValue([BUHANGIN])
    const picker = renderPicker()

    await pickRegion(user, '110000000', /Davao Region/)
    await screen.findByLabelText('Province')
    await user.selectOptions(screen.getByLabelText('Province'), '112400000')
    await screen.findByRole('option', { name: 'Davao City' })
    await user.selectOptions(screen.getByLabelText(/City or municipality/), '112402000')
    await screen.findByRole('option', { name: 'Buhangin' })
    await user.selectOptions(screen.getByLabelText('Barangay'), '112402014')

    expect(picker.get().barangayCode).toBe('112402014')

    // Change the region: a barangay from the old province must not survive.
    listProvinces.mockResolvedValue([])
    await user.selectOptions(screen.getByLabelText('Region'), '130000000')

    expect(picker.get()).toMatchObject({
      regionCode: '130000000',
      provinceCode: null,
      cityCode: null,
      barangayCode: null,
    })
  })
})

describe('logo validation', () => {
  it('accepts the supported types up to 2 MB', () => {
    expect(() => validateLogoFile({ size: 500_000, type: 'image/png' })).not.toThrow()
    expect(() => validateLogoFile({ size: 2 * 1024 * 1024, type: 'image/jpeg' })).not.toThrow()
    expect(() => validateLogoFile({ size: 10, type: 'image/webp' })).not.toThrow()
  })

  it('rejects an oversized file before it is uploaded', () => {
    try {
      validateLogoFile({ size: 3 * 1024 * 1024, type: 'image/png' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LogoValidationError)
      expect((error as LogoValidationError).reason).toBe('too_large')
    }
  })

  it('rejects an unsupported type', () => {
    try {
      validateLogoFile({ size: 100, type: 'image/gif' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as LogoValidationError).reason).toBe('wrong_type')
    }
  })

  it('rejects a PDF masquerading as a logo', () => {
    expect(() => validateLogoFile({ size: 100, type: 'application/pdf' })).toThrow(
      LogoValidationError,
    )
  })
})

describe('category presets', () => {
  it('leads with what the avatar actually sells', () => {
    // Rhea sells skincare and RTW. If those are not the first choices, the list
    // is telling her this product was not built for her.
    expect(CATEGORY_PRESETS[0]!.key).toBe('skincare')
    expect(CATEGORY_PRESETS[1]!.key).toBe('rtw')
  })

  it('has unique keys and both locales for every preset', () => {
    const keys = CATEGORY_PRESETS.map((preset) => preset.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const preset of CATEGORY_PRESETS) {
      expect(preset.labelEn.trim(), preset.key).not.toBe('')
      expect(preset.labelTl.trim(), preset.key).not.toBe('')
      expect(preset.categories.length, preset.key).toBeGreaterThan(0)
    }
  })

  it('picks the label for the active locale', () => {
    const skincare = CATEGORY_PRESETS[0]!
    expect(presetLabel(skincare, 'en')).toBe(skincare.labelEn)
    expect(presetLabel(skincare, 'tl')).toBe(skincare.labelTl)
  })

  it('de-duplicates categories across overlapping presets', () => {
    // Both 'rtw' and 'preloved' contain "Bags"-adjacent overlap; the union must
    // not repeat a category, or phase 3 would create duplicates.
    const categories = categoriesForPresets(['rtw', 'preloved', 'bags-shoes'])
    expect(new Set(categories).size).toBe(categories.length)
    expect(categories.length).toBeGreaterThan(0)
  })

  it('returns nothing for an unknown preset', () => {
    expect(categoriesForPresets(['not-a-preset'])).toEqual([])
    expect(isPresetKey('not-a-preset')).toBe(false)
    expect(isPresetKey('skincare')).toBe(true)
  })
})
