import { describe, expect, it } from 'vitest'

import { parseCsv } from '@/core/cod/statement'

import { CustomerImportError, parseCustomerSheet, toPhMobile } from './import'

/**
 * The corpus, written before the parser and from real export shapes.
 *
 * Each file below is a real thing a Filipino seller has on their laptop: a
 * Shopee order export with two rows of branding above the header and the same
 * buyer on three orders, a Lazada export whose columns are camelCase, a TikTok
 * Shop export, and a spreadsheet somebody typed by hand with the phone number
 * mangled by Excel.
 */

const SHOPEE = `Shopee Order Export
Generated 2026-07-30 · Rhea's Finds
Order ID,Order Status,Username (Buyer),Receiver Name,Phone Number,Delivery Address,Town,City,Province,Product Name,Deal Price
250730ABC1,Completed,rhea_finds_28,Jasmine Villanueva,09171234567,21 Rizal St,Masagana,Quezon City,Metro Manila,Rosehip serum,450
250730ABC2,Completed,marlon.c,Marlon Cruz,+63 918 222 3333,88 Mabini,Poblacion,Davao City,Davao del Sur,Rattan bag,890
250729XYZ9,Completed,rhea_finds_28,Jasmine Villanueva,09171234567,21 Rizal St,Masagana,Quezon City,Metro Manila,Kojic soap,120
250728QQQ1,Cancelled,anna_l,Anna Lim,63 917 555 4444,7 Bonifacio,Sto Nino,Cebu City,Cebu,Rosehip serum,450`

const LAZADA = `orderNumber,createTime,customerName,shippingName,shippingAddress,shippingPhone,billingName,itemName,paidPrice
700123456789,2026-07-28 14:02,liza.m,Liza Mendoza,12 Katipunan Ave Quezon City,0928 111 2222,Liza Mendoza,Vitamin C serum,520
700123456790,2026-07-28 15:40,bebang,Bebang Reyes,4 Aurora Blvd Manila,09281113333,Bebang Reyes,Tote bag,750
700123456791,2026-07-27 09:11,liza.m,Liza Mendoza,12 Katipunan Ave Quezon City,0928 111 2222,Liza Mendoza,Niacinamide,480`

const TIKTOK = `Order ID,Buyer Username,Recipient,Phone #,Detail Address,SKU Subtotal After Discount
5772...,tita_baby,Baby Ramos,(0917) 888-9999,3 Roxas Blvd Pasay,299
5773...,jhen,Jhen Ocampo,+639189990000,9 Session Rd Baguio,410`

const HAND_TYPED = `Name,Contact Number,Email,Notes
Rowena Dela Cruz,9.171234567E+9,rowena@example.ph,Suki since 2024
Truncated Tina,9.17123E+09,,Excel ate her number
Tess Aquino,0917-321-9876,,Prefers COD
Landline Lady,(02) 8888 7777,,Wholesale
,09175550000,,No name on this row
Ramil Bautista,09175551111 / 09285552222,,Two numbers`

const parse = (csv: string) => parseCustomerSheet(parseCsv(csv))

describe('toPhMobile()', () => {
  it('accepts every way a spreadsheet writes one number', () => {
    for (const input of [
      '09171234567',
      '+639171234567',
      '639171234567',
      '9171234567',
      '0917 123 4567',
      '+63 (917) 123-4567',
      "'09171234567",
      '  09171234567  ',
    ]) {
      expect(toPhMobile(input), input).toBe('+639171234567')
    }
  })

  it('restores a number Excel turned into a float, when it still has the digits', () => {
    expect(toPhMobile('9.171234567E+9')).toBe('+639171234567')
  })

  it('refuses one Excel truncated, rather than inventing the missing digits', () => {
    // `9.17123E+09` is what a General-formatted column *displays*. Padding it to
    // ten digits gives +639171230000 — a real number belonging to somebody who
    // never bought anything from this seller.
    expect(toPhMobile('9.17123E+09')).toBeNull()
  })

  it('takes the first usable number when a cell holds two', () => {
    expect(toPhMobile('09175551111 / 09285552222')).toBe('+639175551111')
    expect(toPhMobile('0917 555 1111 or 0928 555 2222')).toBe('+639175551111')
  })

  it('refuses a landline', () => {
    // Every outbound channel Selld has needs a mobile. Storing this would be a
    // customer who cannot be messaged, discovered at broadcast time.
    expect(toPhMobile('(02) 8888 7777')).toBeNull()
    expect(toPhMobile('088 123 4567')).toBeNull()
  })

  it('refuses what is not a number at all', () => {
    expect(toPhMobile('')).toBeNull()
    expect(toPhMobile('N/A')).toBeNull()
    expect(toPhMobile('091712345')).toBeNull()
    expect(toPhMobile('091712345678')).toBeNull()
  })
})

describe('a Shopee order export', () => {
  const parsed = parse(SHOPEE)

  it('is recognised without being told', () => {
    expect(parsed.source).toBe('shopee')
  })

  it('finds the header under two rows of branding', () => {
    expect(parsed.columns.phone).toBe('Phone Number')
  })

  it('takes the receiver, not the username', () => {
    // `rhea_finds_28` is an account. A customer list full of usernames is a
    // customer list nobody can address.
    expect(parsed.columns.name).toBe('Receiver Name')
    expect(parsed.rows.map((row) => row.name)).toEqual([
      'Jasmine Villanueva',
      'Marlon Cruz',
      'Anna Lim',
    ])
  })

  it('collapses one buyer with three orders into one person, and says so', () => {
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.duplicates).toBe(1)
  })

  it('normalises every number to one form', () => {
    expect(parsed.rows.map((row) => row.phone)).toEqual([
      '+639171234567',
      '+639182223333',
      '+639175554444',
    ])
  })
})

describe('a Lazada export', () => {
  const parsed = parse(LAZADA)

  it('is recognised by its camelCase columns', () => {
    expect(parsed.source).toBe('lazada')
    expect(parsed.columns.phone).toBe('shippingPhone')
  })

  it('prefers the shipping name over the account name', () => {
    expect(parsed.rows[0]?.name).toBe('Liza Mendoza')
  })

  it('collapses the repeat buyer', () => {
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.duplicates).toBe(1)
  })
})

describe('a TikTok Shop export', () => {
  const parsed = parse(TIKTOK)

  it('is recognised', () => {
    expect(parsed.source).toBe('tiktok')
  })

  it('reads a phone written with brackets and dashes', () => {
    expect(parsed.rows.map((row) => row.phone)).toEqual(['+639178889999', '+639189990000'])
  })
})

describe('a spreadsheet somebody typed', () => {
  const parsed = parse(HAND_TYPED)

  it('is not mistaken for a marketplace file', () => {
    expect(parsed.source).toBe('generic')
  })

  it('keeps the three rows that are people', () => {
    expect(parsed.rows.map((row) => row.name)).toEqual([
      'Rowena Dela Cruz',
      'Tess Aquino',
      'Ramil Bautista',
    ])
  })

  it('says why it dropped the others, by row number', () => {
    // A seller who imported 400 rows and got 397 needs to know which three, and
    // "row 4 has no name" is actionable in a way that "3 skipped" is not.
    expect(parsed.skipped).toEqual([
      { row: 3, reason: 'not_mobile', cells: expect.anything() },
      { row: 5, reason: 'not_mobile', cells: expect.anything() },
      { row: 6, reason: 'no_name', cells: expect.anything() },
    ])
  })

  it('carries the note across', () => {
    expect(parsed.rows[0]?.note).toBe('Suki since 2024')
    expect(parsed.rows[0]?.email).toBe('rowena@example.ph')
  })
})

describe('files that cannot be read', () => {
  it('refuses one with no recognisable header rather than half-reading it', () => {
    const nonsense = 'a,b,c\n1,2,3\n4,5,6'
    expect(() => parse(nonsense)).toThrow(CustomerImportError)
  })

  it('refuses an empty file', () => {
    expect(() => parseCustomerSheet([])).toThrow(CustomerImportError)
  })

  it('does not treat a header-only file as an error', () => {
    const parsed = parse('Name,Phone\n')
    expect(parsed.rows).toEqual([])
  })
})
