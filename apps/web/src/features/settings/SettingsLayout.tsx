import { NavLink, Outlet } from 'react-router'
import { cn } from '@/lib/cn'
import { routes } from '@/lib/routes'

const SECTIONS = [
  { label: 'Company profile', to: routes.settingsCompany },
  { label: 'Payment details', to: routes.settingsPayment },
  { label: 'Account', to: routes.settingsAccount },
  { label: 'Security', to: routes.settingsSecurity },
]

/** The Settings hub: one sidebar item, four sections (company, payment, account, security). */
export function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections">
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1">
            {SECTIONS.map((s) => (
              <li key={s.to}>
                <NavLink
                  to={s.to}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex min-h-11 w-full items-center rounded-control border px-3 font-medium md:border-transparent',
                      isActive
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-ink hover:bg-neutral-soft',
                    )
                  }
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
