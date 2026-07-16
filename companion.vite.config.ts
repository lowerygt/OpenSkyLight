import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

/**
 * The companion mobile web app — built separately from the electron-vite
 * bundles and served by the runtime from out/companion.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/companion'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  build: {
    outDir: resolve(__dirname, 'out/companion'),
    emptyOutDir: true
  },
  server: {
    // hot-reload UI work against a running kiosk: npm run dev:companion
    proxy: { '/api': 'http://localhost:8420' }
  }
})
