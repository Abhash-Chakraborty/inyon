import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/source-serif-4'
import './styles.css'
import { api } from './lib/api.ts'
import { socket } from './lib/socket.ts'
import { useStore } from './lib/store.ts'
import { AppShell } from './components/AppShell.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Spinner } from './components/ui/primitives.tsx'
import { Home } from './pages/Home.tsx'
import { Login } from './pages/Login.tsx'
import { PanePage } from './pages/PanePage.tsx'
import { Settings } from './pages/Settings.tsx'
import { MachinePage, MachinesPage } from './pages/Machines.tsx'
import { installTapHaptics } from './lib/haptics.ts'
import { installNative, isNative, nativeTheme } from './lib/native.ts'

function useTheme() {
  const theme = useStore((s) => s.settings.theme)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const t = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = t
      useStore.setState({ resolvedTheme: t })
      nativeTheme(t)
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', t === 'dark' ? '#0a0a0b' : '#fafafa'))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

function App() {
  const authed = useStore((s) => s.authed)
  const setAuthed = useStore((s) => s.setAuthed)
  useTheme()

  useEffect(() => {
    api.session().then((s) => setAuthed(s.authed)).catch(() => setAuthed(false))
    const out = () => setAuthed(false)
    window.addEventListener('tether:signed-out', out)
    return () => window.removeEventListener('tether:signed-out', out)
  }, [])

  useEffect(() => {
    if (!authed) return
    socket.start()
    socket.subscribeOverview()
    return () => socket.stop()
  }, [authed])

  if (authed === null) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (!authed) return <Login />

  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="m/:host/p/:pane" element={<PanePage />} />
          <Route path="machines" element={<MachinesPage />} />
          <Route path="machines/:host" element={<MachinePage />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  )
}

installTapHaptics()
installNative()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// Offline shell for the installed app (service workers need HTTPS or localhost).
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD && !isNative()) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
