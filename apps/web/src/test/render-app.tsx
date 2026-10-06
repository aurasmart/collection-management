import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createHashRouter, createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { vi } from 'vitest'
import { routeObjects } from '@/app/router'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { ToastProvider } from '@/components/ui'

export function renderApp(path = '/', opts: { hash?: boolean; strict?: boolean } = {}) {
  // hash: use the REAL hash router against window.location (as production does)
  const router = opts.hash
    ? createHashRouter(routeObjects)
    : createMemoryRouter(routeObjects, { initialEntries: [path] })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const tree = (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
  const utils = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree)
  return { ...utils, router, client }
}

type Handler = (req: Request) => Response | Promise<Response>

/** Route-table fetch mock. Keys look like "GET /api/v1/me". Records every request. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Array<{ key: string; request: Request; body: unknown }> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const key = `${request.method} ${url.pathname}`
    let body: unknown = null
    const type = request.headers.get('content-type') ?? ''
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const clone = request.clone()
      body = type.includes('json')
        ? await clone.json()
        : type.includes('multipart')
          ? await clone.formData()
          : null
    }
    calls.push({ key, request, body })
    const handler = routes[key]
    if (!handler) return Response.json({ detail: `unmocked ${key}` }, { status: 599 })
    return handler(request)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn, called: (key: string) => calls.filter((c) => c.key === key) }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status })
