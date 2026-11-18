import { useEffect, useRef, useState } from 'react'
import { usePushInvalidation, useSettings } from './api/hooks'
import { useTheme } from './lib/useTheme'
import { useUi } from './stores/uiStore'
import { HomeView } from './features/home/HomeView'
import { Header, Fab } from './features/shell/Header'
import { Toasts } from './features/shell/Toasts'
import { UpdateBanner } from './features/shell/UpdateBanner'
import { WeekView } from './features/calendar/WeekView'
import { DayView } from './features/calendar/DayView'
import { MonthView } from './features/calendar/MonthView'
import { AgendaView } from './features/calendar/AgendaView'
import { ChoresView } from './features/chores/ChoresView'
import { ListsView } from './features/lists/ListsView'
import { EventEditor } from './features/calendar/EventEditor'
import { SettingsSheet } from './features/settings/SettingsSheet'
import { KioskOverlays } from './features/kiosk/KioskOverlays'
import { OskTray } from './components/Osk'

export default function App() {
  usePushInvalidation()
  useTheme()
  const view = useUi((s) => s.view)
  const { data: settings } = useSettings()

  // Apply the configured default screen once at boot (only if the user
  // hasn't already navigated away from the initial view).
  const bootApplied = useRef(false)
  // data-app-ready: the boot signal e2e tests (and humans debugging) can trust —
  // set the frame after settings load and the boot view is applied
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!settings || bootApplied.current) return
    bootApplied.current = true
    const state = useUi.getState()
    if (settings.defaultView !== state.view && state.view === 'home') {
      state.setView(settings.defaultView)
    }
    requestAnimationFrame(() => setReady(true))
  }, [settings])

  return (
    <div className="flex h-full flex-col" data-app-ready={ready ? 'true' : undefined}>
      <Header />
      <main className="min-h-0 flex-1">
        {view === 'home' && <HomeView />}
        {view === 'week' && <WeekView />}
        {view === 'day' && <DayView />}
        {view === 'month' && <MonthView />}
        {view === 'agenda' && <AgendaView />}
        {view === 'chores' && <ChoresView />}
        {view === 'lists' && <ListsView />}
      </main>
      {view !== 'chores' && view !== 'lists' && view !== 'home' && <Fab />}
      <EventEditor />
      <SettingsSheet />
      <OskTray />
      <Toasts />
      <UpdateBanner />
      <KioskOverlays />
    </div>
  )
}
