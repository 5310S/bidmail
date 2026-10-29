import { createRoot } from 'react-dom/client'
import { AppProvider } from './state'
import { App } from './App'
import './styles.css'

document.documentElement.classList.add('platform-' + window.bidmail.platform)

createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>
)