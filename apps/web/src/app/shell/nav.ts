import { LayoutDashboard, Receipt, Settings, Upload, type LucideIcon } from 'lucide-react'
import { routes } from '@/lib/routes'

export interface NavItem {
  label: string
  to: string
  icon: LucideIcon
  end?: boolean
}

/** Primary navigation: exactly these four (Stage 2 §1). */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: routes.dashboard, icon: LayoutDashboard, end: true },
  { label: 'Collections', to: routes.collections, icon: Receipt },
  { label: 'Import', to: routes.upload, icon: Upload },
  { label: 'Settings', to: routes.settings, icon: Settings },
]
