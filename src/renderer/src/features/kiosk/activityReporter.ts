import { useEffect } from 'react'
import { createActivityThrottle } from '@shared/activityThrottle'
import { ipcInvoke } from '../../api/client'

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/** Tells main about user activity so the screensaver idle timer works on Linux. */
export function useActivityReporter(): void {
  useEffect(() => {
    const report = createActivityThrottle(() => {
      void ipcInvoke('kiosk:activity', undefined).catch(() => {})
    })
    const opts = { capture: true, passive: true }
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, report, opts)
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, report, opts)
    }
  }, [])
}
