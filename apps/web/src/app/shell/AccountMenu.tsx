import * as Menu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, LogOut, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/features/auth/AuthProvider'
import { routes } from '@/lib/routes'

/** Header account area (Stage 2 §1): signed-in email and Sign out. No tenant switcher. */
export function AccountMenu() {
  const { email, signOut } = useAuth()
  const navigate = useNavigate()

  return (
    <Menu.Root>
      <Menu.Trigger className="inline-flex min-h-11 items-center gap-2 rounded-control px-2 hover:bg-neutral-soft">
        <UserRound className="size-5" aria-hidden="true" />
        <span className="max-w-[16rem] truncate max-sm:sr-only">{email}</span>
        <span className="sr-only">, account menu</span>
        <ChevronDown className="size-4" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-56 rounded-control border border-line bg-surface p-1 shadow-popover"
        >
          <Menu.Label className="truncate px-3 py-2 text-sm text-ink-2">{email}</Menu.Label>
          <Menu.Separator className="my-1 h-px bg-line" />
          <Menu.Item
            onSelect={() => {
              void signOut().then(() => navigate(routes.login, { replace: true }))
            }}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-3 outline-none data-[highlighted]:bg-accent-soft"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
