import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '@/App'
import { initI18n } from '@/lib/i18n'
import { initTelemetry, installGlobalHandlers } from '@/lib/telemetry/report-error'

import './index.css'

// Locale must be resolved before the first render so a Taglish seller never sees
// an English flash on load.
initI18n()

/**
 * Error reporting, before anything can throw.
 *
 * The DSN is a `VITE_` variable and is *meant* to be public — it identifies the
 * project and authorises writes only. Everything that would make an error report
 * dangerous goes through `scrub.ts` first; see the note there about why this is
 * not the vendor SDK.
 */
initTelemetry(
  import.meta.env.VITE_SENTRY_DSN === undefined || import.meta.env.VITE_SENTRY_DSN === ''
    ? null
    : {
        dsn: import.meta.env.VITE_SENTRY_DSN,
        environment: import.meta.env.VITE_APP_ENV ?? 'development',
      },
)
installGlobalHandlers(window)

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Register the service worker — for the dashboard only.
 *
 * `App.tsx` picks a surface by hostname, and only the dashboard entry runs this
 * module. That is what keeps the worker off a buyer's page: the storefront is
 * server-rendered against a hard LCP budget and has nothing to gain from a
 * worker that must boot before it can help.
 *
 * After first paint, not before. Registration is a network fetch and a thread
 * spin-up, and doing it during startup makes the first load slower to make the
 * second load possible — which is the wrong trade for a seller opening the app
 * for the first time on a provincial connection.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unregistered worker costs the offline packing list and nothing else.
      // Never worth failing the app over.
    })
  })
}
