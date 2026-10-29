import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import './index.css'
import App from './App.tsx'

// maplibre-gl 6 loads its worker from a sibling file Vite does not ship; point it at the emitted asset.
setWorkerUrl(new URL(workerUrl, window.location.href).href)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
