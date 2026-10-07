import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { z } from 'zod'
import { Alert, Button, PasswordField, TextField } from '@/components/ui'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { useAuth } from '@/features/auth/AuthProvider'
import { safeNext } from '@/lib/auth-redirect'
import { routes } from '@/lib/routes'

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
})
type Values = z.infer<typeof schema>

const ERRORS = {
  invalid: 'Incorrect email or password.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  network: "Can't reach the server. Check your connection and try again.",
  unknown: 'Something went wrong. Please try again.',
} as const

export function LoginPage() {
  const { status, signIn } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeNext(params.get('next'))
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setFocus,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } })

  useEffect(() => {
    setFocus('email')
  }, [setFocus])

  if (status === 'signed-in') return <Navigate to={next} replace />

  async function onSubmit(values: Values) {
    setFormError(null)
    const result = await signIn(values.email, values.password)
    if (result.ok) {
      navigate(next, { replace: true })
      return
    }
    setFormError(ERRORS[result.reason])
    if (result.reason === 'invalid') {
      resetField('password') // keep the email, clear the password (Stage 2 S1)
      setFocus('password')
    }
  }

  return (
    <AuthLayout title="Sign in">
      {params.get('confirmed') && (
        <Alert tone="success" className="mb-4">
          Your email is confirmed. Sign in to set up your company.
        </Alert>
      )}
      {params.get('expired') && (
        <Alert tone="info" className="mb-4">
          Your session expired. Please sign in again.
        </Alert>
      )}
      {status === 'unconfigured' && (
        <Alert tone="warning" title="Sign-in isn't configured" className="mb-4">
          Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this build.
        </Alert>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
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
        <PasswordField
          label="Password"
          autoComplete="current-password"
          placeholder="Enter your password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" loading={isSubmitting} disabled={status === 'unconfigured'}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link
          to={routes.forgotPassword}
          className="inline-flex min-h-11 items-center justify-center font-medium text-accent hover:underline"
        >
          Forgot password?
        </Link>
        <p className="text-center text-ink-2">
          Don't have an account?{' '}
          <Link
            to={routes.signup}
            className="inline-flex min-h-11 items-center font-medium text-accent hover:underline"
          >
            Sign up
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
