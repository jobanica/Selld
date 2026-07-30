import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '@/App'
import { initI18n } from '@/lib/i18n'

import './index.css'

// Locale must be resolved before the first render so a Taglish seller never sees
// an English flash on load.
initI18n()

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
