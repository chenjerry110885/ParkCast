import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { createLiveArtifacts } from './dev/liveArtifacts.ts'
import { createLocalArtifacts } from './dev/localArtifacts.ts'

/**
 * Forecast files for `npm run dev`. With PARKCAST_LIVE_ORIGIN set, from the live
 * site through a shared, budgeted copy; otherwise from web/.dev-artifacts/.
 * Nothing under public/ -- whatever is there is copied into every build.
 *
 * PARKCAST_DEV_NO_AMENITIES=1 serves the local roster with `m` and `e` stripped
 * off every row: the state of the live site until the collector is rebuilt, and
 * the only way to look at the "nobody said" branch over 1,089 real car parks.
 * See `LocalOptions.stripAmenities`.
 */
function devArtifacts(): Plugin {
  const live = process.env.PARKCAST_LIVE_ORIGIN
  const middleware = live
    ? createLiveArtifacts({ origin: live })
    : createLocalArtifacts(fileURLToPath(new URL('./.dev-artifacts', import.meta.url)), {
        stripAmenities: process.env.PARKCAST_DEV_NO_AMENITIES === '1',
      })
  return {
    name: 'parkcast-dev-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        middleware(req, res, next).catch(next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // The app is served from the root of its workers.dev address (docs/deploy.md).
  // PARKCAST_BASE overrides it -- set it from PowerShell: Git Bash rewrites "/"
  // into a Windows path (measured 2026-09-14).
  base: process.env.PARKCAST_BASE ?? '/',
  plugins: [react(), devArtifacts()],
  // Never reachable from the network: the dev server can read files and relay the live site.
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  test: {
    // jsdom, not node: later tasks render components against this same config.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Registers the jest-dom matchers. Without it `toBeInTheDocument()` fails
    // as "not a function" -- an error that points at the assertion rather than
    // at the missing wiring, and costs the next author an afternoon.
    setupFiles: ['./tests/setup.ts'],
  },
})
