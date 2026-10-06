import { useRef, useState } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import { Alert, Button } from '@/components/ui'
import { readImageSize, releaseStaged, stagedPreview } from '@/lib/image'
import type { QrAction } from '@/features/settings/api'
import { QR_MAX_BYTES, QR_MIN_SIDE } from '@/features/settings/schema'

/** Stages a QR change (upload/remove). Nothing is sent until the form is saved and confirmed. */
export function QrField({
  serverQrUrl,
  action,
  onAction,
  serverError,
}: {
  serverQrUrl: string | null
  action: QrAction
  onAction: (a: QrAction) => void
  serverError?: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const change = (next: QrAction) => {
    if (action.kind === 'upload') releaseStaged(action.file)
    onAction(next)
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setError("This image isn't a supported format. Upload a PNG or JPG.")
      return
    }
    if (file.size > QR_MAX_BYTES) {
      setError('This image is larger than 2 MB.')
      return
    }
    try {
      const { width, height } = await readImageSize(file)
      if (width < QR_MIN_SIDE || height < QR_MIN_SIDE) {
        setError('This image is too small. Use at least 300 × 300 pixels.')
        return
      }
    } catch {
      setError("This image isn't a supported format or is unreadable.")
      return
    }
    change({ kind: 'upload', file })
  }

  const shownUrl =
    action.kind === 'upload'
      ? stagedPreview(action.file)
      : action.kind === 'remove'
        ? null
        : serverQrUrl
  const hasImage = shownUrl !== null
  const message = error ?? serverError ?? null

  return (
    <div className="flex flex-col gap-3">
      {message && <Alert tone="error">{message}</Alert>}
      {hasImage ? (
        <img
          src={shownUrl}
          alt="Current QR code"
          className="size-40 rounded-control border border-line object-contain"
        />
      ) : (
        <p className="text-ink-2">
          {action.kind === 'remove'
            ? 'The QR code will be removed when you save.'
            : 'No QR code uploaded yet.'}
        </p>
      )}
      {action.kind === 'upload' && (
        <p className="text-sm text-info">New image selected. Save to apply it.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="sr-only"
          aria-label="QR code image file"
          onChange={(e) => void onPick(e)}
        />
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          <ImageUp className="size-5" aria-hidden="true" />
          {hasImage ? 'Replace image' : 'Upload QR image'}
        </Button>
        {(serverQrUrl !== null || action.kind === 'upload') && action.kind !== 'remove' && (
          <Button
            variant="destructive-outline"
            onClick={() =>
              action.kind === 'upload' ? onAction({ kind: 'none' }) : onAction({ kind: 'remove' })
            }
          >
            <Trash2 className="size-5" aria-hidden="true" />
            {action.kind === 'upload' ? 'Discard new image' : 'Remove'}
          </Button>
        )}
        {action.kind === 'remove' && (
          <Button variant="secondary" onClick={() => change({ kind: 'none' })}>
            Keep current image
          </Button>
        )}
      </div>
      <p className="text-sm text-ink-2">PNG or JPG, up to 2 MB, at least 300 × 300 pixels.</p>
    </div>
  )
}
