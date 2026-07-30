import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from 'pg'

import { coloursFor, gradientPng } from './demo-images'

/**
 * Seed the demo store, end to end.
 *
 *   pnpm seed:demo
 *
 * Three steps, because a storefront is not useful without all three: the SQL
 * fixture (tenant, catalog, stock), generated product images uploaded to the real
 * Storage bucket, and the `product_images` rows that connect them.
 *
 * Images go through the actual Storage API rather than being faked as local
 * files, so the rendered page loads them cross-origin exactly as production does
 * — including the DNS and TLS cost that `preconnect` exists to hide. Measuring
 * LCP against same-origin placeholder files would quietly remove the slowest part
 * of the real thing.
 */

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const API_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const BUCKET = 'tenant-public'
const IMAGE_SIZE = 900
/**
 * Downscaled widths written alongside each original.
 *
 * 400 is what the 2-column grid actually needs on a 390px viewport at 2× DPR;
 * 700 covers the product page's main image on a phone. Without these the grid
 * downloads seven 900px originals — measured at LCP 3.2s against a 2.0s budget,
 * which is what put this list here.
 */
const RENDITIONS = [400, 700]

async function upload(path: string, png: Buffer): Promise<void> {
  const response = await fetch(`${API_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'image/png',
      // Long-lived: the object is named for the product slug and replaced
      // wholesale when the seller uploads a new photo.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'x-upsert': 'true',
    },
    body: new Uint8Array(png),
  })

  if (!response.ok) {
    throw new Error(
      `Upload failed for ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`,
    )
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()

  try {
    console.log('→ applying supabase/seed/demo-store.sql')
    const sql = readFileSync(join(process.cwd(), 'supabase/seed/demo-store.sql'), 'utf8')
    // Strip psql meta-commands: they are for the psql client, and node-postgres
    // sends the text straight to the server, which does not understand them.
    await client.query(sql.replace(/^\\set .*$/gm, ''))

    const { rows: products } = await client.query<{
      id: string
      tenant_id: string
      slug: string
      name: string
    }>(
      `select p.id, p.tenant_id, p.slug, p.name
       from public.products p
         join public.tenants t on t.id = p.tenant_id
       where t.slug = 'rheas-finds' and p.status = 'active'
       order by p.created_at desc`,
    )

    if (products.length === 0) throw new Error('Demo seed produced no active products.')
    console.log(`→ ${products.length} active products`)

    if (SERVICE_KEY === '') {
      console.warn(
        '! SUPABASE_SERVICE_ROLE_KEY is not set — skipping image upload.\n' +
          '  The store will render with letter placeholders instead of photos, which\n' +
          '  makes any LCP measurement optimistic. Set it to seed images.',
      )
      return
    }

    console.log('→ generating and uploading product images')
    let uploaded = 0
    for (const product of products) {
      const { inner, outer } = coloursFor(product.slug)
      const path = `${product.tenant_id}/products/${product.slug}.png`

      // Original plus every rendition. The rendition naming convention lives in
      // `renditionPath()` on the read side; keep the two in step.
      for (const width of [IMAGE_SIZE, ...RENDITIONS]) {
        const target =
          width === IMAGE_SIZE ? path : path.replace(/\.png$/, `@${width}.png`)
        await upload(target, gradientPng(width, inner, outer))
      }

      // No width/height columns on product_images, and the storefront does not
      // need them: every image sits in an `aspect-square` container, so the space
      // is reserved from CSS before the bytes arrive. `renditions` is different —
      // srcset cannot be built without knowing which widths exist.
      await client.query(
        `insert into public.product_images
           (tenant_id, product_id, storage_path, alt, sort_order, renditions)
         values ($1, $2, $3, $4, 0, $5)
         on conflict do nothing`,
        [product.tenant_id, product.id, path, `${product.name} product photo`, RENDITIONS],
      )
      uploaded += 1
    }

    console.log(
      `→ uploaded ${uploaded} products × ${1 + RENDITIONS.length} sizes ` +
        `(${[IMAGE_SIZE, ...RENDITIONS].join('/')}px PNG)`,
    )
    console.log('\nDemo store ready. Run `pnpm dev:store` then open:')
    console.log('  http://rheas-finds.localhost:5174/')
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
