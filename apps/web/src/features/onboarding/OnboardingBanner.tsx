import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Alert } from '@/components/ui'
import { getOnboarding, setOnboarding } from '@/features/onboarding/onboarding'
import { routes } from '@/lib/routes'

const link = 'inline-flex min-h-11 items-center font-medium text-accent hover:underline'

/** Shown on the first two Settings screens right after sign up. Nothing here is mandatory. */
export function OnboardingBanner() {
  const [active, setActive] = useState(() => getOnboarding() === 'active')
  const { pathname } = useLocation()
  if (!active) return null
  const finish = () => {
    setOnboarding(null)
    setActive(false)
  }
  if (pathname === routes.settingsCompany) {
    return (
      <Alert tone="info" title="Welcome! Step 1 of 2: your company details">
        <p>Add your company information. Customers see your name and logo on their payment page.</p>
        <div className="flex flex-wrap gap-x-4">
          <Link to={routes.settingsPayment} className={link}>
            Next: Payment details
          </Link>
          <Link to={routes.dashboard} onClick={finish} className={link}>
            Skip to dashboard
          </Link>
        </div>
      </Alert>
    )
  }
  if (pathname === routes.settingsPayment) {
    return (
      <Alert tone="info" title="Step 2 of 2: how customers pay you">
        <p>Add your UPI ID, QR code or bank details. You can also do this later.</p>
        <div className="flex flex-wrap gap-x-4">
          <Link to={routes.dashboard} onClick={finish} className={link}>
            Finish and go to the dashboard
          </Link>
        </div>
      </Alert>
    )
  }
  return null
}
