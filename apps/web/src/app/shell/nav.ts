import { LayoutDashboard, Receipt, Settings, Upload, Wallet, type LucideIcon } from 'lucide-react'
import { routes } from '@/lib/routes'

export interface NavItem {
  label: string
  to: string
  icon: LucideIcon
  end?: boolean
}

/** Primary navigation: these five (Stage 2 §1; Petty Cash added by ADR 0008). */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: routes.dashboard, icon: LayoutDashboard, end: true },
  { label: 'Collections', to: routes.collections, icon: Receipt },
  { label: 'Petty Cash', to: routes.pettyCash, icon: Wallet },
  { label: 'Import', to: routes.upload, icon: Upload },
  { label: 'Settings', to: routes.settings, icon: Settings },
]
