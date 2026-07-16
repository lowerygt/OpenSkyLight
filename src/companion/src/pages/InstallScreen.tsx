import { GhostButton } from '../components/ui'

export function InstallScreen({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <img src="/icon-192.png" alt="" className="h-20 w-20 rounded-3xl shadow-card" />
      <h1 className="font-display text-3xl font-semibold">Install OpenSkyLight</h1>
      <p className="max-w-xs text-base font-semibold text-ink-soft">
        Save this page to your Home Screen first, then open the installed app and scan the kiosk QR code again.
      </p>
      <ol className="max-w-xs list-decimal space-y-1.5 pl-5 text-left text-base font-semibold text-ink-soft">
        <li>Tap Share in Safari</li>
        <li>Choose <span className="font-extrabold">Add to Home Screen</span></li>
        <li>Open the Home Screen app, then scan the QR code from Settings → General</li>
      </ol>
      <GhostButton onClick={onRefresh}>I opened the app — refresh</GhostButton>
    </div>
  )
}
