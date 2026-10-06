import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { Providers } from '@/app/providers'
import { createAppRouter } from '@/app/router'
import { normalizeAuthRedirect } from '@/lib/auth-redirect'
import '@/styles/index.css'

// An auth email link can overwrite the router hash: repair it BEFORE the router reads the URL.
const fixed = normalizeAuthRedirect(window.location)
if (fixed) window.history.replaceState(null, '', fixed)

const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
