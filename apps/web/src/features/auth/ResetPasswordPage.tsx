import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'
import { Alert, Button, PasswordField, Skeleton } from '@/components/ui'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { readAuthRedirect, scrubAuthParams } from '@/lib/auth-redirect'
import { routes } from '@/lib/routes'
import { supabase } from '@/lib/supabase'

export const MIN_PASSWORD_LENGTH = 8

const schema = z
  .object({
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`),
    confirm: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
type Values = z.infer<typeof schema>

type Phase =
  { kind: 'checking' } | { kind: 'ready' } | { kind: 'invalid'; message: string } | { kind: 'done' }

const LINK_ERRORS: Record<string, string> = {
  otp_expired: 'This reset link has expired. Request a new one.',
  access_denied: 'This reset link is no longer valid. Request a new one.',
  unsupported_flow: 'This reset link is not supported. Request a new one.',
}
const GENERIC_INVALID = 'This reset link is invalid or has already been used. Request a new one.'
const NEEDS_SAME_BROWSER =
  "Open the reset link in the same browser where you requested it. If you've already opened it somewhere else, request a new link."

/**
 * A recovery code may be exchanged exactly once. React StrictMode runs effects twice in development,
 * so the in-flight exchange is cached per code.
 */
const exchanges = new Map<string, Promise<string | null>>()

function exchangeOnce(code: string, flowId: string | null): Promise<string | null> {
  const existing = exchanges.get(code)
  if (existing) return existing
  const p = (async () => {
    if (!supabase) return GENERIC_INVALID
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(
        code,
        flowId ? { flowId } : undefined,
      )
      if (!error) return null
      return error.name === 'AuthPKCECodeVerifierMissingError'
        ? NEEDS_SAME_BROWSER
        : GENERIC_INVALID
    } catch {
      return "Can't reach the server. Check your connection and try again."
    }
  })()
  exchanges.set(code, p)
  // Only de-duplicate concurrent runs (StrictMode); a settled exchange must never be replayed from cache.
  void p.finally(() => exchanges.delete(code))
  return p
}

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  })

  useEffect(() => {
    let cancelled = false
    const link = readAuthRedirect(window.location.search)
    const finish = (p: Phase) => {
      if (!cancelled) setPhase(p)
    }
    void (async () => {
      if (link.errorCode) {
        scrubAuthParams()
        finish({ kind: 'invalid', message: LINK_ERRORS[link.errorCode] ?? GENERIC_INVALID })
        return
      }
      if (link.code) {
        const failure = await exchangeOnce(link.code, link.flowId)
        scrubAuthParams() // the one-time code must not stay in the address bar / history
        finish(failure ? { kind: 'invalid', message: failure } : { kind: 'ready' })
        return
      }
      // Reloaded after a successful exchange: the recovery session is already stored.
      const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } }
      finish(data.session ? { kind: 'ready' } : { kind: 'invalid', message: GENERIC_INVALID })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function onSubmit({ password }: Values) {
    setSubmitError(null)
    if (!supabase) return
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (!error) {
        setPhase({ kind: 'done' })
        return
      }
      if (error.code === 'same_password') {
        setSubmitError('Choose a password you have not used before.')
      } else if (error.code === 'weak_password') {
        setSubmitError('This password is too easy to guess. Choose a stronger one.')
      } else if (error.status === 401 || error.status === 403) {
        setPhase({ kind: 'invalid', message: GENERIC_INVALID })
      } else {
        setSubmitError('Could not update your password. Please try again.')
      }
    } catch {
      setSubmitError("Can't reach the server. Check your connection and try again.")
    }
  }

  return (
    <AuthLayout title="Set a new password">
      {phase.kind === 'checking' && (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Checking your reset link…</span>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      )}
      {phase.kind === 'invalid' && (
        <div className="flex flex-col gap-4">
          <Alert tone="error" title="Reset link problem">
            {phase.message}
          </Alert>
          <Link
            to={routes.forgotPassword}
            className="inline-flex min-h-11 items-center justify-center font-medium text-accent hover:underline"
          >
            Request a new link
          </Link>
        </div>
      )}
      {phase.kind === 'ready' && (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          {submitError && <Alert tone="error">{submitError}</Alert>}
          <PasswordField
            label="New password"
            autoComplete="new-password"
            required
            helper={`At least ${MIN_PASSWORD_LENGTH} characters`}
            error={errors.password?.message}
            {...register('password')}
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            required
            error={errors.confirm?.message}
            {...register('confirm')}
          />
          <Button type="submit" loading={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
      {phase.kind === 'done' && (
        <div className="flex flex-col gap-4">
          <Alert tone="success" title="Password updated">
            You are signed in with your new password.
          </Alert>
          <Button onClick={() => navigate(routes.dashboard, { replace: true })}>Continue</Button>
        </div>
      )}
    </AuthLayout>
  )
}
