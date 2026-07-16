import { useRef, useState } from 'react'
import BarcodeScanner from 'react-qr-barcode-scanner'
import { BarcodeStringFormat } from 'react-qr-barcode-scanner'
import { GhostButton, PrimaryButton, TextInput } from '../components/ui'
import { adoptTokenFromPairingUrl } from '../api/client'

export function PairScreen({ onRetry }: { onRetry: () => void }) {
  const [showScanner, setShowScanner] = useState(false)
  const [stopStream, setStopStream] = useState(false)
  const [scannerError, setScannerError] = useState<string | null>(null)
  const [manualUrl, setManualUrl] = useState('')
  const resolvedRef = useRef(false)

  async function startScanner(): Promise<void> {
    resolvedRef.current = false
    setScannerError(null)
    setStopStream(false)
    setShowScanner(true)
  }

  function closeScanner(): void {
    setStopStream(true)
    setTimeout(() => {
      setShowScanner(false)
      setStopStream(false)
    }, 0)
  }

  function submitManualLink(): void {
    if (adoptTokenFromPairingUrl(manualUrl.trim())) {
      onRetry()
      return
    }
    setScannerError('That link does not look like a valid pairing QR URL.')
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <img src="/icon-192.png" alt="" className="h-20 w-20 rounded-3xl shadow-card" />
      <h1 className="font-display text-3xl font-semibold">OpenSkyLight</h1>
      <p className="max-w-xs text-base font-semibold text-ink-soft">
        This phone isn't paired with the family display.
      </p>
      <ol className="max-w-xs list-decimal space-y-1.5 pl-5 text-left text-base font-semibold text-ink-soft">
        <li>On the display, open Settings → General</li>
        <li>
          Under <span className="font-extrabold">Companion app</span>, tap{' '}
          <span className="font-extrabold">Pair a phone</span>
        </li>
        <li>Scan the QR code with this phone's camera</li>
      </ol>
      {showScanner ? (
        <div className="flex w-full max-w-xs flex-col gap-3">
          <div className="overflow-hidden rounded-xl bg-black">
            <BarcodeScanner
              width="100%"
              height={260}
              facingMode="environment"
              stopStream={stopStream}
              formats={[BarcodeStringFormat.QR_CODE]}
              onError={(err) => {
                setScannerError(
                  err instanceof DOMException && err.name === 'NotAllowedError'
                    ? 'Camera access was denied. Allow camera permission or paste the pairing link below.'
                    : 'Could not access camera. Allow camera permission or paste the pairing link below.'
                )
                closeScanner()
              }}
              onUpdate={(_err, result) => {
                if (resolvedRef.current || !result) return
                const raw = result.getText()
                if (!raw || !adoptTokenFromPairingUrl(raw)) return
                resolvedRef.current = true
                closeScanner()
                onRetry()
              }}
            />
          </div>
          <GhostButton
            onClick={() => {
              closeScanner()
            }}
          >
            Stop camera
          </GhostButton>
        </div>
      ) : (
        <PrimaryButton onClick={() => void startScanner()}>Scan QR with camera</PrimaryButton>
      )}
      <div className="flex w-full max-w-xs flex-col gap-2">
        <TextInput value={manualUrl} onChange={setManualUrl} placeholder="Paste pairing link" />
        <GhostButton onClick={submitManualLink}>Use pasted link</GhostButton>
      </div>
      {scannerError ? <p className="max-w-xs text-sm font-semibold text-red-600">{scannerError}</p> : null}
      <GhostButton onClick={onRetry}>I've scanned it — retry</GhostButton>
    </div>
  )
}
