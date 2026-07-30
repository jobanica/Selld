import { describe, expect, it } from 'vitest'

import { isReservedSlug, isValidSlug, resolveSurface } from './resolve-tenant'

const options = { rootDomain: 'selld.ph' }

describe('resolveSurface()', () => {
  it('serves the dashboard on the apex domain', () => {
    expect(resolveSurface('selld.ph', options)).toEqual({ kind: 'dashboard' })
    expect(resolveSurface('SELLD.PH', options)).toEqual({ kind: 'dashboard' })
    expect(resolveSurface('selld.ph:5173', options)).toEqual({ kind: 'dashboard' })
  })

  it('serves the dashboard on reserved subdomains', () => {
    for (const host of ['app.selld.ph', 'www.selld.ph', 'admin.selld.ph', 'api.selld.ph']) {
      expect(resolveSurface(host, options), host).toEqual({ kind: 'dashboard' })
    }
  })

  it('serves a storefront on a tenant subdomain', () => {
    expect(resolveSurface('rhea.selld.ph', options)).toEqual({
      kind: 'storefront',
      slug: 'rhea',
    })
    expect(resolveSurface('rheas-finds.selld.ph', options)).toEqual({
      kind: 'storefront',
      slug: 'rheas-finds',
    })
  })

  it('supports *.localhost for local storefront development', () => {
    expect(resolveSurface('rhea.localhost', options)).toEqual({
      kind: 'storefront',
      slug: 'rhea',
    })
    expect(resolveSurface('rhea.localhost:5173', options)).toEqual({
      kind: 'storefront',
      slug: 'rhea',
    })
  })

  it('serves the dashboard on bare localhost and IPs', () => {
    expect(resolveSurface('localhost', options)).toEqual({ kind: 'dashboard' })
    expect(resolveSurface('localhost:5173', options)).toEqual({ kind: 'dashboard' })
    expect(resolveSurface('127.0.0.1:5173', options)).toEqual({ kind: 'dashboard' })
  })

  it('treats an unrelated hostname as a custom domain', () => {
    expect(resolveSurface('shop.rheasfinds.com', options)).toEqual({
      kind: 'custom-domain',
      hostname: 'shop.rheasfinds.com',
    })
  })

  it('does not treat nested subdomains as store slugs', () => {
    expect(resolveSurface('a.b.selld.ph', options)).toEqual({ kind: 'dashboard' })
  })

  it('rejects slugs that are not valid DNS labels', () => {
    // Too short to be a slug, so it falls back to the dashboard rather than
    // resolving a store that cannot exist.
    expect(resolveSurface('ab.selld.ph', options)).toEqual({ kind: 'dashboard' })
  })

  it('works for an alternate root domain', () => {
    expect(resolveSurface('rhea.selld.store', { rootDomain: 'selld.store' })).toEqual({
      kind: 'storefront',
      slug: 'rhea',
    })
    // The same host is a custom domain when the root domain differs.
    expect(resolveSurface('rhea.selld.store', options)).toEqual({
      kind: 'custom-domain',
      hostname: 'rhea.selld.store',
    })
  })
})

describe('isValidSlug()', () => {
  it('accepts DNS-safe slugs', () => {
    for (const slug of ['rhea', 'rheas-finds', 'shop123', 'a1b']) {
      expect(isValidSlug(slug), slug).toBe(true)
    }
  })

  it('rejects slugs that cannot be hostnames', () => {
    for (const slug of ['ab', '-rhea', 'rhea-', 'Rhea', 'rhea shop', 'rhea_shop', '', 'a'.repeat(64)]) {
      expect(isValidSlug(slug), slug).toBe(false)
    }
  })
})

describe('isReservedSlug()', () => {
  it('protects our own hostnames', () => {
    expect(isReservedSlug('app')).toBe(true)
    expect(isReservedSlug('ADMIN')).toBe(true)
    expect(isReservedSlug('rhea')).toBe(false)
  })
})
