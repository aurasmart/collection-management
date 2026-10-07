import { createHashRouter, type RouteObject } from 'react-router'
import { AppShell } from '@/app/shell/AppShell'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { NotFoundPage } from '@/app/pages/NotFound'
import { CollectionDetailPage } from '@/features/collections/CollectionDetailPage'
import { CollectionsPage } from '@/features/collections/CollectionsPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { UploadPage } from '@/features/imports/UploadPage'
import { PayPage } from '@/features/pay/PayPage'
import { SettingsPage } from '@/features/settings/SettingsPage'

/** Hash routing for GitHub Pages (docs/adr/0002). Paths come from lib/routes.ts. */
export const routeObjects: RouteObject[] = [
  // Public auth screens live OUTSIDE the guard, so signed-out users can never loop.
  { path: 'login', element: <LoginPage /> },
  { path: 'forgot-password', element: <ForgotPasswordPage /> },
  { path: 'reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'collections', element: <CollectionsPage /> },
          { path: 'collections/:id', element: <CollectionDetailPage /> },
          { path: 'upload', element: <UploadPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
  // Public, customer-facing: standalone layout, outside the employer shell.
  { path: 'pay/:token', element: <PayPage /> },
]

export const createAppRouter = () => createHashRouter(routeObjects)
