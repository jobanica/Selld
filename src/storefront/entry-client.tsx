import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { StorefrontRoot, type StorefrontPage } from './storefront-root'

import '../index.css'

/**
 * Client entry for the storefront.
 *
 * Note what is absent: no data fetching, no Supabase client, no router, no
 * TanStack Query. The server inlined the payload into the document, so hydration
 * is purely about attaching event handlers to markup that is already correct and
 * already visible. That is what keeps this chunk small enough to load *after* the
 * page is readable instead of before.
 */

interface BootstrapState {
  data: StorefrontPage
  storageOrigin: string
  origin: string
  basePath?: string
  cartCount?: number
  cartBump?: boolean
}

function readState(): BootstrapState | null {
  const element = document.getElementById('selld-state')
  if (element === null) return null
  try {
    return JSON.parse(element.textContent ?? '') as BootstrapState
  } catch {
    // Malformed state means the server and client would disagree about the DOM.
    // Leaving the server-rendered HTML alone is strictly better than hydrating
    // onto a guess: the page stays readable, only the picker goes inert.
    return null
  }
}

const container = document.getElementById('root')
const state = readState()

if (container !== null && state !== null) {
  hydrateRoot(
    container,
    <StrictMode>
      <StorefrontRoot
        data={state.data}
        storageOrigin={state.storageOrigin}
        origin={state.origin}
        basePath={state.basePath ?? ''}
        cartCount={state.cartCount ?? 0}
        cartBump={state.cartBump ?? false}
      />
    </StrictMode>,
  )
}
