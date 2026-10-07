import { useRef, useState } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import { Alert, Button } from '@/components/ui'
import { readImageSize, releaseStaged, stagedPreview } from '@/lib/image'
import type { LogoAction } from '@/features/settings/companyApi'
import { LOGO_MAX_BYTES, LOGO_MIN_SIDE } from '@/features/settings/companySchema'

const TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** Stages a logo change (upload/remove). Nothing is sent until the form is saved and confirmed. */
export function LogoField({
  serverLogoUrl,
  action,
  onAction,
  serverError,
}: {
  serverLogoUrl: string | null
  action: LogoAction
  onAction: (a: LogoAction) => void
  serverError?: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const change = (next: LogoAction) => {
    if (action.kind === 'upload') releaseStaged(action.file)
    onAction(next)
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    if (!TYPES.includes(file.type)) {
      setError("This image isn't a supported format. Upload a PNG, JPG or WebP.")
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError('This image is larger than 2 MB.')
      return
    }
    try {
      const { width, height } = await readImageSize(file)
      if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE) {
        setError('This image is too small. Use at least 64 × 64 pixels.')
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
        : serverLogoUrl
  const hasImage = shownUrl !== null
  const message = error ?? serverError ?? null

  return (
    <div className="flex flex-col gap-3">
      {message && <Alert tone="error">{message}</Alert>}
      {hasImage ? (
        <img
          src={shownUrl}
          alt="Current company logo"
          className="h-24 max-w-full self-start rounded-control border border-line bg-surface object-contain p-2"
        />
      ) : (
        <p className="text-ink-2">
          {action.kind === 'remove'
            ? 'The logo will be removed when you save.'
            : 'No logo uploaded yet.'}
        </p>
      )}
      {action.kind === 'upload' && (
        <p className="text-sm text-info">New logo selected. Save to apply it.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Company logo image file"
          onChange={(e) => void onPick(e)}
        />
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          <ImageUp className="size-5" aria-hidden="true" />
          {hasImage ? 'Replace logo' : 'Upload logo'}
        </Button>
        {(serverLogoUrl !== null || action.kind === 'upload') && action.kind !== 'remove' && (
          <Button
            variant="destructive-outline"
            onClick={() =>
              action.kind === 'upload' ? change({ kind: 'none' }) : onAction({ kind: 'remove' })
            }
          >
            <Trash2 className="size-5" aria-hidden="true" />
            {action.kind === 'upload' ? 'Discard new logo' : 'Remove logo'}
          </Button>
        )}
        {action.kind === 'remove' && (
          <Button variant="secondary" onClick={() => change({ kind: 'none' })}>
            Keep current logo
          </Button>
        )}
      </div>
      <p className="text-sm text-ink-2">
        PNG, JPG or WebP (no SVG), up to 2 MB, at least 64 × 64 pixels. Shown on your customers'
        payment page.
      </p>
    </div>
  )
}
