import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Register the service worker, so the app opens in a basement car park.
 *
 * **Production only.** A worker sitting in front of the Vite dev server serves
 * yesterday's module for today's edit, and the resulting bug reads as haunted
 * code rather than as a caching problem. In dev the guard is skipped at
 * runtime, not compiled away: the module Vite serves opens with a literal
 * `import.meta.env = {..."PROD": false...}` and still contains this `if`
 * verbatim (checked against `vite dev`'s own output, not assumed). Only a
 * production build folds the constant, and there it folds to `true`, so the
 * block is kept and runs. Either way the behaviour is the one described -- but
 * do not reach for `PROD` expecting dead-code elimination in dev.
 *
 * The URL is built from `BASE_URL` (`/ParkCast/` in a Pages build) so the
 * worker's scope is the app's own sub-path and not the whole origin.
 *
 * Registration is wired to `load` and its failure is swallowed on purpose: the
 * app works without a worker, an insecure origin or a disabled-storage browser
 * rejects here, and neither is a reason to interrupt a driver looking for a
 * parking space.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {})
  })
}
