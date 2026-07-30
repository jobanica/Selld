import { describe, expect, it } from 'vitest'

import {
  formatPhPhone,
  isPhMobile,
  isValidPhPhone,
  maskPhPhone,
  normalizePhPhone,
  parsePhPhone,
  parsePhPhoneDetailed,
} from './ph-phone'

describe('mobile numbers', () => {
  it('normalises every way a seller types the same number', () => {
    const inputs = [
      '09171234567',
      '0917 123 4567',
      '0917-123-4567',
      '(0917) 123 4567',
      '0917.123.4567',
      '+639171234567',
      '+63 917 123 4567',
      '+63-917-123-4567',
      '639171234567',
      '63 917 123 4567',
      '00639171234567',
      '9171234567',
      '  09171234567  ',
    ]
    for (const input of inputs) {
      expect(normalizePhPhone(input), `input: ${input}`).toBe('+639171234567')
    }
  })

  it('exposes the parsed parts', () => {
    const phone = parsePhPhone('09171234567')
    expect(phone).toEqual({
      e164: '+639171234567',
      nsn: '9171234567',
      kind: 'mobile',
      areaCode: null,
      national: '0917 123 4567',
    })
  })

  it('covers the major network prefixes', () => {
    for (const prefix of ['905', '906', '915', '917', '926', '935', '945', '955', '965', '975', '985', '995', '999']) {
      expect(normalizePhPhone(`0${prefix}1234567`)).toBe(`+63${prefix}1234567`)
    }
  })

  it('rejects mobile numbers of the wrong length', () => {
    expect(parsePhPhone('0917123456')).toBeNull() // one digit short
    expect(parsePhPhone('091712345678')).toBeNull() // one digit long
  })
})

describe('landline numbers', () => {
  it('parses Metro Manila (area code 2, 8 subscriber digits)', () => {
    const phone = parsePhPhone('(02) 8123 4567')
    expect(phone).toEqual({
      e164: '+63281234567',
      nsn: '281234567',
      kind: 'landline',
      areaCode: '2',
      national: '(02) 8123 4567',
    })
  })

  it('parses provincial landlines (2-digit area code, 7 subscriber digits)', () => {
    expect(parsePhPhone('(082) 234 5678')?.e164).toBe('+63822345678')
    expect(parsePhPhone('(032) 234 5678')?.areaCode).toBe('32')
    expect(parsePhPhone('0822345678')?.kind).toBe('landline')
  })

  it('treats a 9-digit number starting with 63 as an Iligan landline, not a country code', () => {
    // 63 is both the country code and the Lanao del Norte area code. Because we
    // validate before stripping, this stays a landline instead of being mangled.
    const phone = parsePhPhone('0632345678')
    expect(phone?.kind).toBe('landline')
    expect(phone?.areaCode).toBe('63')
    expect(phone?.e164).toBe('+63632345678')
  })

  it('rejects unknown area codes', () => {
    const result = parsePhPhoneDetailed('0992345678')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unknown_area_code')
  })
})

describe('rejections', () => {
  it('reports empty input', () => {
    for (const input of ['', '   ', null, undefined]) {
      const result = parsePhPhoneDetailed(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('empty')
    }
  })

  it('reports non-Philippine international numbers', () => {
    for (const input of ['+14155552671', '+6591234567', '+442071838750']) {
      const result = parsePhPhoneDetailed(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('not_philippine')
    }
  })

  it('rejects text and malformed input', () => {
    expect(parsePhPhone('not a phone')).toBeNull()
    expect(parsePhPhone('63+9171234567')).toBeNull()
    expect(parsePhPhone('0917')).toBeNull()
    expect(parsePhPhone('1')).toBeNull()
  })

  it('is a boolean guard too', () => {
    expect(isValidPhPhone('09171234567')).toBe(true)
    expect(isValidPhPhone('nope')).toBe(false)
  })
})

describe('SMS eligibility', () => {
  it('only mobiles can receive SMS', () => {
    expect(isPhMobile('09171234567')).toBe(true)
    expect(isPhMobile('(02) 8123 4567')).toBe(false)
    expect(isPhMobile('garbage')).toBe(false)
  })
})

describe('display helpers', () => {
  it('formats for reading back', () => {
    expect(formatPhPhone('+639171234567')).toBe('0917 123 4567')
    expect(formatPhPhone('+63281234567')).toBe('(02) 8123 4567')
  })

  it('falls back to the raw input rather than blanking a seller field', () => {
    expect(formatPhPhone('pending confirmation')).toBe('pending confirmation')
    expect(formatPhPhone('')).toBe('')
  })

  it('masks numbers for shared views', () => {
    expect(maskPhPhone('09171234567')).toBe('0917 •••• 4567')
    expect(maskPhPhone('(082) 234 5678')).toBe('(082) •••• 5678')
    expect(maskPhPhone('garbage')).toBe('')
  })
})

describe('idempotence', () => {
  it('normalising an already-normalised number is a no-op', () => {
    for (const input of ['09171234567', '(02) 8123 4567', '(082) 234 5678']) {
      const once = normalizePhPhone(input)
      expect(once).not.toBeNull()
      expect(normalizePhPhone(once)).toBe(once)
    }
  })
})
