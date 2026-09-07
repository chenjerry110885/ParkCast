import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Where a production build expects to be served from.
 *
 * GitHub Pages serves a project site under the repository name, so a build made
 * for the root would ask for `/assets/...` and get the user's 404 page. Setting
 * it here rather than passing `--base` at build time means the deploy is one
 * `npm run build` with no flag to forget; `PARKCAST_BASE` overrides it for a
 * root domain (`PARKCAST_BASE=/`) or a CDN prefix.
 *
 * Dev and test stay at `/`: `command` is `serve` for both, and pinning them to
 * the sub-path would only make every local URL longer.
 *
 * `preview` is the exception, and needs asking for by name. It serves the
 * *build*, whose HTML already points at `/ParkCast/assets/...`, so serving it
 * from `/` gives a blank page and a wall of 404s -- and `command` is `serve`
 * there too, which is why `isPreview` has to carry the distinction. This is the
 * only way to check a Pages build locally, service worker scope included.
 */
const PAGES_BASE = '/ParkCast/'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  base: process.env.PARKCAST_BASE ?? (command === 'build' || isPreview ? PAGES_BASE : '/'),
  plugins: [react()],
  test: {
    // jsdom, not node: later tasks render components against this same config.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Registers the jest-dom matchers. Without it `toBeInTheDocument()` fails
    // as "not a function" -- an error that points at the assertion rather than
    // at the missing wiring, and costs the next author an afternoon.
    setupFiles: ['./tests/setup.ts'],
  },
}))
