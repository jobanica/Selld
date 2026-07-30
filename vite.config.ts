import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Storefronts resolve by subdomain ({slug}.selld.ph). Allow wildcard hosts in
    // dev so `foo.localhost:5173` reaches the same server as the dashboard.
    host: true,
  },
  build: {
    // Sellers are on mid-range Android phones over mobile data. Keep an eye on
    // bundle growth from phase 5 onward, where LCP < 2.0s on 3G is the target.
    chunkSizeWarningLimit: 600,
    sourcemap: true,
  },
})
