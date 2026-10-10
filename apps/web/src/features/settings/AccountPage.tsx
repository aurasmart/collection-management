import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { LogOut } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import { Alert, Button, Card, PasswordField, Skeleton, useToast } from '@/components/ui'
import { useAuth, type ChangePasswordResult } from '@/features/auth/AuthProvider'
import { useMe } from '@/features/auth/useMe'
import { routes } from '@/lib/routes'

export const MIN_PASSWORD_LENGTH = 8

const schema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`),
    confirm: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
  .refine((v) => !v.current || v.password !== v.current, {
    path: ['password'],
    message: 'Choose a password different from your current one',
  })
type Values = z.infer<typeof schema>

const FAILURES: Record<Exclude<ChangePasswordResult, { ok: true }>['reason'], string> = {
  wrong_current: 'Your current password is incorrect.',
  same: 'Choose a password different from your current one.',
  weak: 'That password is too easy to guess. Try a longer or less common one.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  network: "Can't reach the server. Check your connection and try again.",
  unknown: 'Something went wrong. Please try again.',
}

export function AccountPage() {
  const { email, signOut } = useAuth()
  const me = useMe()
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-semibold">Account</h2>
      <Card aria-label="Your account" className="flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Your account</h3>
        <dl className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-ink-2">Signed in as</dt>
          <dd className="font-medium break-all">{email}</dd>
          <dt className="text-ink-2">Account name</dt>
          <dd className="font-medium break-words">
            {me.isPending ? <Skeleton className="h-5 w-40" /> : (me.data?.name ?? '—')}
          </dd>
        </dl>
        <div>
          <Button
            variant="secondary"
            onClick={() => void signOut().then(() => navigate(routes.login, { replace: true }))}
          >
            <LogOut className="size-5" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </Card>
      <ChangePasswordCard />
    </div>
  )
}

function ChangePasswordCard() {
  const { changePassword } = useAuth()
  const { toast } = useToast()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { current: '', password: '', confirm: '' },
  })

  async function onSubmit(v: Values) {
    setFailure(null)
    const result = await changePassword(v.current, v.password)
    if (result.ok) {
      reset()
      toast({ title: 'Password changed', tone: 'success' })
      return
    }
    setFailure(FAILURES[result.reason])
  }

  return (
    <Card aria-label="Change password" className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">Change password</h3>
      {failure && <Alert tone="error">{failure}</Alert>}
      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        aria-label="Change password form"
        className="flex max-w-md flex-col gap-4"
      >
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          required
          error={errors.current?.message}
          {...register('current')}
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          required
          helper={`At least ${MIN_PASSWORD_LENGTH} characters.`}
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
        <div>
          <Button type="submit" loading={isSubmitting}>
            {isSubmitting ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
