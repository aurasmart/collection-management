import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/features/auth/AuthProvider'
import { PasswordConfirmModal } from '@/features/auth/PasswordConfirmModal'
import { routes } from '@/lib/routes'

/** Stage 2 S12: shown over the current screen, so unsaved form data stays intact. */
export function SessionExpiredModal({ open }: { open: boolean }) {
  const { email, confirmPassword, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <PasswordConfirmModal
      open={open}
      dismissible={false}
      title="Your session expired"
      description="For your security, please enter your password to continue where you left off."
      email={email}
      submitLabel="Sign in again"
      cancelLabel="Sign out"
      onSubmit={confirmPassword}
      onCancel={() => {
        const next = `${location.pathname}${location.search}`
        void signOut().then(() =>
          navigate(`${routes.login}?next=${encodeURIComponent(next)}`, { replace: true }),
        )
      }}
    />
  )
}
