import { createHashRouter, type RouteObject } from 'react-router'
import { AppShell } from '@/app/shell/AppShell'
import { NotFoundPage } from '@/app/pages/NotFound'
import { PayPlaceholderPage } from '@/app/pages/PayPlaceholder'
import { CollectionsPage, DashboardPage, SettingsPage, UploadPage } from '@/app/pages/pages'

/** Hash routing for GitHub Pages (docs/adr/0002). Paths come from lib/routes.ts. */
export const routeObjects: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'collections', element: <CollectionsPage /> },
      { path: 'upload', element: <UploadPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  // Public, customer-facing: standalone layout, outside the employer shell.
  { path: 'pay/:token', element: <PayPlaceholderPage /> },
]

export const createAppRouter = () => createHashRouter(routeObjects)
