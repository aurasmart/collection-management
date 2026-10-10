import { createHashRouter, Navigate, type RouteObject } from 'react-router'
import { AppShell } from '@/app/shell/AppShell'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { SignupPage } from '@/features/auth/SignupPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { NotFoundPage } from '@/app/pages/NotFound'
import { CollectionDetailPage } from '@/features/collections/CollectionDetailPage'
import { CollectionsPage } from '@/features/collections/CollectionsPage'
import { PettyCashPage } from '@/features/petty-cash/PettyCashPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { UploadPage } from '@/features/imports/UploadPage'
import { PayPage } from '@/features/pay/PayPage'
import { AccountPage } from '@/features/settings/AccountPage'
import { CompanyProfilePage } from '@/features/settings/CompanyProfilePage'
import { PaymentDetailsPage } from '@/features/settings/PaymentDetailsPage'
import { SecurityPage } from '@/features/settings/SecurityPage'
import { SettingsLayout } from '@/features/settings/SettingsLayout'

/** Hash routing for GitHub Pages (docs/adr/0002). Paths come from lib/routes.ts. */
export const routeObjects: RouteObject[] = [
  // Public auth screens live OUTSIDE the guard, so signed-out users can never loop.
  { path: 'login', element: <LoginPage /> },
  { path: 'signup', element: <SignupPage /> },
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
          { path: 'petty-cash', element: <PettyCashPage /> },
          { path: 'upload', element: <UploadPage /> },
          {
            path: 'settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="company" replace /> },
              { path: 'company', element: <CompanyProfilePage /> },
              { path: 'payment', element: <PaymentDetailsPage /> },
              { path: 'account', element: <AccountPage /> },
              { path: 'security', element: <SecurityPage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
  // Public, customer-facing: standalone layout, outside the employer shell.
  { path: 'pay/:token', element: <PayPage /> },
]

export const createAppRouter = () => createHashRouter(routeObjects)
