import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { MailCheck } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useNavigate } from 'react-router'
import { z } from 'zod'
import { Alert, Button, PasswordField, TextField } from '@/components/ui'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { useAuth, type SignUpResult } from '@/features/auth/AuthProvider'
import { routes } from '@/lib/routes'

export const MIN_PASSWORD_LENGTH = 12

const schema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name').max(80, 'Use at most 80 characters'),
    email: z.string().trim().min(1, 'Enter your work email').email('Enter a valid email address'),
    companyName: z
      .string()
      .trim()
      .min(2, 'Enter your company or business name')
      .max(60, 'Use at most 60 characters'),
    phone: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{8,15}$/.test(v.replace(/[\s\-().+]/g, '')), {
        message: 'Enter a valid phone number',
      }),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`),
    confirm: z.string().min(1, 'Re-enter your password'),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
type Values = z.infer<typeof schema>

const FAILURES: Record<Exclude<SignUpResult, { ok: true }>['reason'], string> = {
  exists: 'An account with this email already exists. Sign in instead.',
  weak: 'That password is too easy to guess. Try a longer or less common one.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  network: "Can't reach the server. Check your connection and try again.",
  unknown: 'Something went wrong. Please try again.',
}

export function SignupPage() {
  const { status, signUp } = useAuth()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: '',
      email: '',
      companyName: '',
      phone: '',
      password: '',
      confirm: '',
    },
  })

  useEffect(() => {
    setFocus('fullName')
  }, [setFocus])

  if (status === 'signed-in' && confirmEmail === null)
    return <Navigate to={routes.dashboard} replace />

  async function onSubmit(v: Values) {
    setFormError(null)
    const result = await signUp({
      fullName: v.fullName,
      email: v.email,
      companyName: v.companyName,
      phone: v.phone,
      password: v.password,
    })
    if (!result.ok) {
      if (result.reason === 'exists') setError('email', { message: FAILURES.exists })
      else setFormError(FAILURES[result.reason])
      return
    }
    if (result.next === 'confirm_email') {
      setConfirmEmail(v.email.trim().toLowerCase())
      return
    }
    navigate(routes.dashboard, { replace: true }) // already signed in: the workspace is set up next
  }

  if (confirmEmail) {
    return (
      <AuthLayout title="Check your email">
        <div className="flex flex-col gap-4">
          <Alert tone="success" title="Account created">
            <span className="flex items-start gap-2">
              <MailCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                We sent a confirmation link to <strong className="break-all">{confirmEmail}</strong>
                . Open it, then sign in to set up your company.
              </span>
            </span>
          </Alert>
          <Link
            to={routes.login}
            className="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-4 font-medium text-white hover:bg-accent-hover"
          >
            Go to sign in
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Create your account">
      {status === 'unconfigured' && (
        <Alert tone="warning" title="Sign-up isn't configured" className="mb-4">
          Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this build.
        </Alert>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
        <TextField
          label="Full name"
          autoComplete="name"
          placeholder="e.g. Asha Rao"
          required
          error={errors.fullName?.message}
          {...register('fullName')}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="username"
          inputMode="email"
          placeholder="name@company.com"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Company / business name"
          autoComplete="organization"
          placeholder="Name your customers know you by"
          required
          error={errors.companyName?.message}
          {...register('companyName')}
        />
        <TextField
          label="Phone number (optional)"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          placeholder="e.g. 98765 43210"
          error={errors.phone?.message}
          {...register('phone')}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          required
          helper={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={errors.password?.message}
          {...register('password')}
        />
        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          required
          error={errors.confirm?.message}
          {...register('confirm')}
        />
        <Button type="submit" loading={isSubmitting} disabled={status === 'unconfigured'}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-center text-ink-2">
          Already have an account?{' '}
          <Link
            to={routes.login}
            className="inline-flex min-h-11 items-center font-medium text-accent hover:underline"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
