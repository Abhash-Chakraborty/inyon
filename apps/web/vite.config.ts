import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HUB = process.env.TETHER_HUB ?? 'http://127.0.0.1:4777'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': HUB,
      '/ws': { target: HUB.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
})
