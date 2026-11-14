import { StrictMode, useEffect } from 'react'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { MonitorPanel } from './MonitorPanel'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// The detached Monitoring window loads this same page with `#monitor`. It shows
// only the Monitoring view and follows the theme chosen in the main window.
function MonitorWindow(): JSX.Element {
  useEffect(() => {
    const apply = (): void =>
      document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') ?? 'dark')
    apply()
    document.title = 'Lemonade Stand – Monitoring'
    // Fires when the main window changes the theme (same origin, other window).
    const onStorage = (e: StorageEvent): void => {
      if (e.key === 'theme') apply()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return <MonitorPanel variant="windowed" />
}

createRoot(root).render(
  <StrictMode>{window.location.hash === '#monitor' ? <MonitorWindow /> : <App />}</StrictMode>
)
