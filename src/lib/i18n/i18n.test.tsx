import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useTranslation } from 'react-i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import { LocaleSwitcher } from '@/components/locale-switcher'

import { detectLocale, i18next, initI18n, isLocale, LOCALE_STORAGE_KEY } from './index'
import { en } from './locales/en'
import { tl } from './locales/tl'

function Probe() {
  const { t } = useTranslation()
  return (
    <div>
      <span data-testid="orders">{t('nav.orders')}</span>
      <LocaleSwitcher />
    </div>
  )
}

describe('translation catalogues', () => {
  it('tl covers every key in en', () => {
    const keyPaths = (value: unknown, prefix = ''): string[] => {
      if (typeof value !== 'object' || value === null) return [prefix]
      return Object.entries(value).flatMap(([key, child]) =>
        keyPaths(child, prefix ? `${prefix}.${key}` : key),
      )
    }

    expect(keyPaths(tl).sort()).toEqual(keyPaths(en).sort())
  })

  it('has no untranslated leftovers — every tl string is non-empty', () => {
    const walk = (value: unknown, path = ''): void => {
      if (typeof value === 'string') {
        expect(value.trim(), `empty translation at ${path}`).not.toBe('')
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          walk(child, path ? `${path}.${key}` : key)
        }
      }
    }
    walk(tl)
  })

  it('keeps loanwords sellers actually use rather than deep Tagalog', () => {
    // These read as machine-translated if localised, and cost credibility.
    expect(tl.nav.dashboard).toBe('Dashboard')
    expect(tl.nav.liveSelling).toBe('Live Selling')
    expect(tl.nav.shipping).toBe('Shipping')
  })
})

describe('detectLocale()', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('prefers a stored choice', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tl')
    expect(detectLocale()).toBe('tl')
  })

  it('ignores a stored value that is not a supported locale', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es')
    expect(detectLocale()).toBe('en')
  })

  it('recognises Filipino locale tags', () => {
    expect(isLocale('tl')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fil')).toBe(false)
  })
})

describe('locale switching', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    initI18n('en')
    await i18next.changeLanguage('en')
  })

  it('renders English by default', () => {
    render(<Probe />)
    expect(screen.getByTestId('orders')).toHaveTextContent('Orders')
  })

  it('switches to Taglish and persists the choice', async () => {
    const user = userEvent.setup()
    render(<Probe />)

    expect(screen.getByTestId('orders')).toHaveTextContent('Orders')

    await user.click(screen.getByTestId('locale-switcher'))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Taglish' }))

    expect(screen.getByTestId('orders')).toHaveTextContent('Mga Order')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tl')
  })

  it('switches back to English', async () => {
    const user = userEvent.setup()
    await i18next.changeLanguage('tl')
    render(<Probe />)

    expect(screen.getByTestId('orders')).toHaveTextContent('Mga Order')

    await user.click(screen.getByTestId('locale-switcher'))
    await user.click(await screen.findByRole('menuitemradio', { name: 'English' }))

    expect(screen.getByTestId('orders')).toHaveTextContent('Orders')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
  })
})
