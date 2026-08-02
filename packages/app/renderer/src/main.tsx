import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initializeI18n } from './i18n'
import { initializeTheme } from './theme'
import './styles.css'

initializeTheme()
initializeI18n()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
