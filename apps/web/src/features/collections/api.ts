import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { api, fieldErrors, type ApiFieldError } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'

export type CollectionRow = components['schemas']['CollectionRow']
export type CollectionDetail = components['schemas']['CollectionDetail']
export type CollectionEdit = components['schemas']['CollectionEdit']
export type StatusFilter = 'ALL' | 'PENDING' | 'PAID'

export const PAGE_SIZE = 50

export function useCollections(status: StatusFilter, q: string, page: number) {
  const { status: auth } = useAuth()
  return useQuery({
    queryKey: ['collections', status, q, page],
    enabled: auth === 'signed-in',
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/collections', {
        params: {
          query: {
            status: status === 'ALL' ? undefined : status,
            q: q || undefined,
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
          },
        },
      })
      if (error || !data) throw new Error('Could not load customers')
      return data
    },
  })
}

export function useCollection(id: string) {
  const { status: auth } = useAuth()
  return useQuery({
    queryKey: ['collection', id],
    enabled: auth === 'signed-in',
    retry: false,
    queryFn: async () => {
      const { data, response } = await api.GET('/api/v1/collections/{collection_id}', {
        params: { path: { collection_id: id } },
      })
      if (!data)
        throw Object.assign(new Error('Could not load customer'), { status: response.status })
      return data
    },
  })
}

/** After any change, the list, the detail and the dashboard numbers must all refresh. */
function useRefreshAll() {
  const qc = useQueryClient()
  return (detail?: CollectionDetail) => {
    if (detail) qc.setQueryData(['collection', detail.id], detail)
    void qc.invalidateQueries({ queryKey: ['collections'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }
}

type Action = 'payment-page' | 'mark-paid' | 'mark-unpaid'

export function useCollectionAction(id: string, action: Action) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: async () => {
      const path = {
        'payment-page': '/api/v1/collections/{collection_id}/payment-page',
        'mark-paid': '/api/v1/collections/{collection_id}/mark-paid',
        'mark-unpaid': '/api/v1/collections/{collection_id}/mark-unpaid',
      } as const
      const { data } = await api.POST(path[action], { params: { path: { collection_id: id } } })
      if (!data) throw new Error('Action failed')
      return data
    },
    onSuccess: (detail) => refresh(detail),
  })
}

export type EditResult =
  { ok: true; data: CollectionDetail } | { ok: false; errors: ApiFieldError[]; message: string }

export function useEditCollection(id: string) {
  const refresh = useRefreshAll()
  return async (body: CollectionEdit): Promise<EditResult> => {
    try {
      const { data, error, response } = await api.PUT('/api/v1/collections/{collection_id}', {
        params: { path: { collection_id: id } },
        body,
      })
      if (data) {
        refresh(data)
        return { ok: true, data }
      }
      const detail = (error as { detail?: unknown } | undefined)?.detail
      return {
        ok: false,
        errors: fieldErrors(error),
        message:
          typeof detail === 'string'
            ? detail
            : response.status === 422
              ? ''
              : "Couldn't save. Try again.",
      }
    } catch {
      return { ok: false, errors: [], message: "Can't reach the server. Check your connection." }
    }
  }
}
