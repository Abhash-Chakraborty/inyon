import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HUB = process.env.TETHER_HUB ?? 'http://127.0.0.1:4777'

/** the commit a build came from, shown next to the version in Settings */
const commit = () => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __TETHER_COMMIT__: JSON.stringify(commit()) },
  // the phone app runs the hub's core in-process (loaded only inside the app, see lib/phone.ts)
  resolve: { alias: { '@tether/phone': fileURLToPath(new URL('../hub/src/phone/index.ts', import.meta.url)) } },
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
