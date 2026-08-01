import { describe, expect, it } from 'vitest'

import {
  isReservedSlug,
  isValidSlug,
  resolveSurface,
  slugify,
  storeAddress,
  storeHref,
} from './resolve-tenant'

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
      basePath: '',
    })
    expect(resolveSurface('rheas-finds.selld.ph', options)).toEqual({
      kind: 'storefront',
      slug: 'rheas-finds',
      basePath: '',
    })
  })

  it('supports *.localhost for local storefront development', () => {
    expect(resolveSurface('rhea.localhost', options)).toEqual({
      kind: 'storefront',
      slug: 'rhea',
      basePath: '',
    })
    expect(resolveSurface('rhea.localhost:5173', options)).toEqual({
      kind: 'storefront',
      slug: 'rhea',
      basePath: '',
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
      basePath: '',
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
      basePath: '',
    })
    // The same host is a custom domain when the root domain differs.
    expect(resolveSurface('rhea.selld.store', options)).toEqual({
      kind: 'custom-domain',
      hostname: 'rhea.selld.store',
      basePath: '',
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

describe('slugify()', () => {
  it('suggests a slug from a store name', () => {
    expect(slugify("Rhea's Finds")).toBe('rheas-finds')
    expect(slugify('Marlon Kicks PH')).toBe('marlon-kicks-ph')
    expect(slugify('  Double  Spaces  ')).toBe('double-spaces')
  })

  it('keeps Filipino names legible instead of mangling them', () => {
    // ñ is common in PH store names. Naively stripping non-ASCII would yield
    // "nio-s-kicks"; decomposing first keeps the letter.
    expect(slugify("Niño's Kicks")).toBe('ninos-kicks')
    expect(slugify('Señora Beauty')).toBe('senora-beauty')
    expect(slugify('Café Manila')).toBe('cafe-manila')
  })

  it('produces something isValidSlug accepts, or nothing at all', () => {
    for (const name of ["Rhea's Finds", 'Niño', 'ABC', '123 Store', 'Tindahan ni Aling Nena']) {
      const slug = slugify(name)
      expect(isValidSlug(slug), `${name} -> ${slug}`).toBe(true)
    }
  })

  it('never emits a leading or trailing hyphen', () => {
    expect(slugify('!!! Store !!!')).toBe('store')
    expect(slugify('---')).toBe('')
    expect(slugify('')).toBe('')
  })

  it('truncates to a valid DNS label length without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(62)} b`)
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug.endsWith('-')).toBe(false)
    expect(isValidSlug(slug)).toBe(true)
  })
})

describe('path-mounted storefronts', () => {
  const on = (hostname: string, pathname: string) =>
    resolveSurface(hostname, { rootDomain: 'selld.ph', pathname })

  it('gives a store an address on a host that cannot issue subdomains', () => {
    // The real case: deployed on *.vercel.app, which has no wildcard, so the
    // platform host *is* the root domain and stores hang off its path.
    expect(
      resolveSurface('selld.vercel.app', {
        rootDomain: 'selld.vercel.app',
        pathname: '/store/davao-biryani',
      }),
    ).toEqual({
      kind: 'storefront',
      slug: 'davao-biryani',
      basePath: '/store/davao-biryani',
    })
  })

  it('a custom domain is itself a store, so its paths are its own pages', () => {
    // `shop.rheasfinds.com/store/x` is a page in Rhea's shop, not store `x`.
    expect(on('shop.rheasfinds.com', '/store/davao-biryani')).toEqual({
      kind: 'custom-domain',
      hostname: 'shop.rheasfinds.com',
      basePath: '',
    })
  })

  it('mounts every page of the shop under the same prefix', () => {
    for (const path of ['/store/rhea', '/store/rhea/', '/store/rhea/p/soap', '/store/rhea/cart']) {
      const surface = on('selld.ph', path)
      expect(surface, path).toMatchObject({ kind: 'storefront', slug: 'rhea' })
    }
  })

  it('leaves the dashboard alone', () => {
    expect(on('selld.ph', '/orders')).toEqual({ kind: 'dashboard' })
    expect(on('selld.ph', '/')).toEqual({ kind: 'dashboard' })
  })

  it('does not collide with the phase 16 short link prefix', () => {
    // `/s/{slug}` is a broadcast short link and must never resolve to a store.
    expect(on('selld.ph', '/s/abc123')).toEqual({ kind: 'dashboard' })
  })

  it('refuses a reserved name through the path, exactly as through a subdomain', () => {
    expect(on('selld.ph', '/store/admin')).toEqual({ kind: 'dashboard' })
    expect(resolveSurface('admin.selld.ph', { rootDomain: 'selld.ph' })).toEqual({
      kind: 'dashboard',
    })
  })

  it('refuses a path that is not a valid slug rather than guessing', () => {
    for (const path of ['/store/', '/store/ab', '/store/Not A Slug', '/store']) {
      expect(on('selld.ph', path), path).toEqual({ kind: 'dashboard' })
    }
  })

  it('a store hostname wins — a shop cannot mount another shop inside itself', () => {
    expect(on('rhea.selld.ph', '/store/davao-biryani')).toEqual({
      kind: 'storefront',
      slug: 'rhea',
      basePath: '',
    })
  })

  it('is opt-in: without a pathname nothing changes', () => {
    expect(resolveSurface('selld.ph', { rootDomain: 'selld.ph' })).toEqual({ kind: 'dashboard' })
  })
})

describe('storeHref', () => {
  it('is the identity function for a subdomain store', () => {
    expect(storeHref('', '/')).toBe('/')
    expect(storeHref('', '/p/soap')).toBe('/p/soap')
    expect(storeHref('', '/cart/add')).toBe('/cart/add')
  })

  it('mounts a path store without doubling the slash', () => {
    expect(storeHref('/store/rhea', '/')).toBe('/store/rhea')
    expect(storeHref('/store/rhea', '/p/soap')).toBe('/store/rhea/p/soap')
    expect(storeHref('/store/rhea', '/checkout')).toBe('/store/rhea/checkout')
  })
})

describe('storeAddress', () => {
  it('is the subdomain the product is designed around', () => {
    expect(storeAddress('rhea', { rootDomain: 'selld.ph', mode: 'subdomain' })).toBe('rhea.selld.ph')
  })

  it('falls back to a path where the host has no wildcard to give', () => {
    expect(storeAddress('rhea', { rootDomain: 'selld.vercel.app', mode: 'path' })).toBe(
      'selld.vercel.app/store/rhea',
    )
  })

  it('produces an address resolveSurface agrees is that store', () => {
    // The seller is shown this string; a buyer types it. If the two disagree the
    // seller is handing out a link to nothing.
    for (const mode of ['subdomain', 'path'] as const) {
      const address = storeAddress('rhea', { rootDomain: 'selld.ph', mode })
      const [hostname, ...rest] = address.split('/')
      expect(
        resolveSurface(hostname as string, {
          rootDomain: 'selld.ph',
          pathname: `/${rest.join('/')}`,
        }),
        mode,
      ).toMatchObject({ kind: 'storefront', slug: 'rhea' })
    }
  })
})
