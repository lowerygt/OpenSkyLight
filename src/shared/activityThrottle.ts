export const ACTIVITY_REPORT_MS = 3_000

/** Leading-edge throttle: the first activity after a quiet spell is sent at once. */
export function createActivityThrottle(send: () => void, intervalMs = ACTIVITY_REPORT_MS, now = Date.now) {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < intervalMs) return
    last = t
    send()
  }
}
