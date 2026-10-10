import { KeyRound, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { Card } from '@/components/ui'
import { routes } from '@/lib/routes'

/** Plain-language security information. There is nothing to configure: the rules are built in. */
export function SecurityPage() {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-semibold">Security</h2>
      <Card aria-label="Password" className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="size-5" aria-hidden="true" />
          Password
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-ink-2">
          <li>Your password must be at least 8 characters.</li>
          <li>We never see or store your password in this app. Sign-in is handled securely.</li>
          <li>
            You can change it any time from{' '}
            <Link className="text-accent underline" to={routes.settingsAccount}>
              Settings → Account
            </Link>
            , or use "Forgot password?" on the sign-in page.
          </li>
        </ul>
      </Card>
      <Card aria-label="Password confirmation" className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5" aria-hidden="true" />
          When we ask for your password again
        </h3>
        <p className="text-ink-2">
          To protect your customers, we ask you to confirm your password before you change anything
          they rely on when paying:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-ink-2">
          <li>
            Payment details: UPI ID, UPI number, QR code and bank details (
            <Link className="text-accent underline" to={routes.settingsPayment}>
              Payment details
            </Link>
            ).
          </li>
          <li>
            Company details customers can see: name, logo, phone, email, address and GSTIN (
            <Link className="text-accent underline" to={routes.settingsCompany}>
              Company profile
            </Link>
            ).
          </li>
        </ul>
        <p className="text-ink-2">
          If you signed in with your password within the last 5 minutes, you are not asked again.
          Changes are recorded with the field names only, never the values.
        </p>
      </Card>
    </div>
  )
}
