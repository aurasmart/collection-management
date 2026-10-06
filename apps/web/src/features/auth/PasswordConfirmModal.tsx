import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Modal, PasswordField } from '@/components/ui'
import type { SignInResult } from '@/features/auth/AuthProvider'

const MAX_ATTEMPTS = 3
const LOCK_MS = 60_000

const MESSAGES = {
  invalid: 'Incorrect password.',
  rate_limited: 'Too many attempts. Try again later.',
  network: "Can't reach the server. Check your connection and try again.",
  unknown: 'Something went wrong. Please try again.',
} as const

/** Shared by the session-expiry modal (Stage 2 S12) and the sensitive-change confirmation (S10). */
export function PasswordConfirmModal(props: Props) {
  // Mounted only while open, so every opening starts with a clean form and attempt counter.
  return props.open ? <ConfirmBody {...props} /> : null
}

interface Props {
  open: boolean
  title: string
  description: string
  email?: string | null
  submitLabel: string
  dismissible: boolean
  onSubmit: (password: string) => Promise<SignInResult>
  onCancel: () => void
  cancelLabel?: string
  extra?: ReactNode
}

function ConfirmBody({
  open,
  title,
  description,
  email,
  submitLabel,
  dismissible,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
  extra,
}: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const locked = now < lockedUntil

  useEffect(() => {
    if (!locked) return
    const t = window.setTimeout(() => {
      setNow(Date.now())
      setFailures(0)
      setError(null)
    }, lockedUntil - Date.now())
    return () => window.clearTimeout(t)
  }, [locked, lockedUntil])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy || locked) return
    setBusy(true)
    setError(null)
    const result = await onSubmit(password)
    setBusy(false)
    if (result.ok) {
      setPassword('')
      setFailures(0)
      return
    }
    setPassword('')
    inputRef.current?.focus()
    if (result.reason === 'invalid') {
      const next = failures + 1
      setFailures(next)
      if (next >= MAX_ATTEMPTS) {
        setNow(Date.now())
        setLockedUntil(Date.now() + LOCK_MS)
        setError(MESSAGES.rate_limited)
        return
      }
    }
    setError(MESSAGES[result.reason])
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o && dismissible) onCancel()
      }}
      title={title}
      description={description}
      dismissible={dismissible}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" form="confirm-password-form" loading={busy} disabled={locked}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="confirm-password-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {email && (
          <div>
            <span className="text-sm text-ink-2">Signed in as</span>
            <p className="font-medium break-all">{email}</p>
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <PasswordField
          ref={inputRef}
          label="Password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={locked}
        />
        {extra}
      </form>
    </Modal>
  )
}
