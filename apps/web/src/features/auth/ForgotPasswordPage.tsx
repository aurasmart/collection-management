import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router'
import { z } from 'zod'
import { Alert, Button, TextField } from '@/components/ui'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { env } from '@/lib/env'
import { routes } from '@/lib/routes'
import { supabase } from '@/lib/supabase'

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
})
type Values = z.infer<typeof schema>

/** Where Supabase sends the user back. The route lives in the hash (ADR 0002); `code` arrives in the query. */
// eslint-disable-next-line react-refresh/only-export-components
export function resetRedirectUrl(): string {
  const base =
    env.publicAppUrl || `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/$/, '')
  return `${base}/#${routes.resetPassword}`
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '' } })

  async function onSubmit({ email }: Values) {
    setError(null)
    if (!supabase) {
      setError('Sign-in is not configured for this build.')
      return
    }
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: resetRedirectUrl(),
      })
      if (err?.status === 429) {
        setError('Too many attempts. Try again in a few minutes.')
        return
      }
      if (err?.name === 'AuthRetryableFetchError') {
        setError("Can't reach the server. Check your connection and try again.")
        return
      }
      // Always the same message, whether or not the email is registered (no account enumeration).
      setSent(true)
    } catch {
      setError("Can't reach the server. Check your connection and try again.")
    }
  }

  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success" title="Check your email">
            If this email is registered, a reset link has been sent. Open it in this same browser.
          </Alert>
          <Link
            to={routes.login}
            className="inline-flex min-h-11 items-center justify-center font-medium text-accent hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          <p className="text-ink-2">
            Enter your email and we'll send you a link to set a new password.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder="name@company.com"
            required
            error={errors.email?.message}
            {...register('email')}
          />
          <Button type="submit" loading={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
          <Link
            to={routes.login}
            className="inline-flex min-h-11 items-center justify-center font-medium text-accent hover:underline"
          >
            Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  )
}
