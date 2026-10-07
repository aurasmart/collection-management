import { NavLink, Outlet } from 'react-router'
import { cn } from '@/lib/cn'
import { AccountMenu } from '@/app/shell/AccountMenu'
import { NAV_ITEMS } from '@/app/shell/nav'
import { useMe } from '@/features/auth/useMe'
import { useCompanyProfile } from '@/features/settings/companyApi'

/**
 * Responsive shell (Stage 2 §1/§25), one <nav> whose layout changes by breakpoint:
 *   <640px   fixed bottom tab bar (icon + label)
 *   640-1023 left icon rail (labels available to assistive tech)
 *   >=1024   left sidebar with labels
 */
export function AppShell() {
  const me = useMe()
  const company = useCompanyProfile()
  // The company name set in Settings wins; the account name is only the fallback.
  const workspace = company.data?.display_name ?? me.data?.name
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        onClick={(e) => {
          // Hash router owns the URL hash, so move focus instead of changing location.
          e.preventDefault()
          document.getElementById('main')?.focus()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-surface px-4 sm:pl-[calc(72px+1rem)] lg:pl-[calc(15rem+1.5rem)]">
        <span className="text-lg font-semibold">Collections</span>
        {workspace && (
          <span className="ml-3 hidden truncate text-ink-2 sm:inline" title="Workspace">
            {workspace}
          </span>
        )}
        <div className="ml-auto">
          <AccountMenu />
        </div>
      </header>

      <nav
        aria-label="Primary"
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]',
          'sm:inset-y-0 sm:right-auto sm:left-0 sm:w-[72px] sm:flex-col sm:gap-1 sm:border-t-0 sm:border-r sm:px-2 sm:pt-16 sm:pb-4',
          'lg:w-60 lg:px-3',
        )}
      >
        {NAV_ITEMS.map(({ label, to, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={label}
            className={({ isActive }) =>
              cn(
                'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium',
                'sm:min-h-11 sm:flex-none sm:flex-row sm:justify-center sm:rounded-control sm:text-base',
                'lg:justify-start lg:gap-3 lg:px-3',
                isActive ? 'text-accent sm:bg-accent-soft' : 'text-ink-2 hover:text-ink',
              )
            }
          >
            <Icon className="size-6 sm:size-5" aria-hidden="true" />
            <span className="sm:sr-only lg:not-sr-only">{label}</span>
          </NavLink>
        ))}
      </nav>

      <main
        id="main"
        tabIndex={-1}
        className="px-4 pt-6 pb-24 outline-none sm:pb-8 sm:pl-[calc(72px+1.5rem)] sm:pr-6 lg:pl-[calc(15rem+2rem)] lg:pr-8"
      >
        <div className="mx-auto max-w-[1200px]">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
