import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this project from /green2go-map-quote/, not /.
  // Local dev keeps using / so `npm run dev` URLs are unaffected.
  base: process.env.GITHUB_PAGES ? '/green2go-map-quote/' : '/',
})
