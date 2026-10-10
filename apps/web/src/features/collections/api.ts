import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components, paths } from '@collections/api-types'
import { api, fieldErrors, type ApiFieldError } from '@/lib/api'
import { fileForm } from '@/lib/receipt'
import { useAuth } from '@/features/auth/AuthProvider'

export type CollectionRow = components['schemas']['CollectionRow']
export type CollectionDetail = components['schemas']['CollectionDetail']
export type CollectionEdit = components['schemas']['CollectionEdit']
export type StatusFilter = 'ALL' | 'PENDING' | 'PAID'

export const PAGE_SIZE = 50

export type Sort = NonNullable<paths['/api/v1/collections']['get']['parameters']['query']>['sort']

/** Everything the list can be narrowed or ordered by. Empty strings mean "not set". */
export interface CollectionFilters {
  status: StatusFilter
  q: string
  sort: NonNullable<Sort>
  overdue: boolean
  dueFrom: string
  dueTo: string
  minAmount: string
  maxAmount: string
  createdFrom: string
  createdTo: string
  paymentPage: '' | 'yes' | 'no'
  hasPhone: '' | 'yes' | 'no'
}

export const NO_FILTERS: CollectionFilters = {
  status: 'ALL',
  q: '',
  sort: 'created_desc',
  overdue: false,
  dueFrom: '',
  dueTo: '',
  minAmount: '',
  maxAmount: '',
  createdFrom: '',
  createdTo: '',
  paymentPage: '',
  hasPhone: '',
}

export function useCollections(f: CollectionFilters, page: number) {
  const { status: auth } = useAuth()
  return useQuery({
    queryKey: ['collections', f, page],
    enabled: auth === 'signed-in',
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/collections', {
        params: {
          query: {
            status: f.status === 'ALL' ? undefined : f.status,
            q: f.q || undefined,
            sort: f.sort,
            overdue: f.overdue || undefined,
            due_from: f.dueFrom || undefined,
            due_to: f.dueTo || undefined,
            min_amount: f.minAmount || undefined,
            max_amount: f.maxAmount || undefined,
            created_from: f.createdFrom || undefined,
            created_to: f.createdTo || undefined,
            payment_page: f.paymentPage || undefined,
            has_phone: f.hasPhone || undefined,
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

/** Delete one customer (DELETE) or several at once (all or nothing). The list and dashboard refresh. */
export function useDeleteCollections() {
  const qc = useQueryClient()
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 1) {
        const { response } = await api.DELETE('/api/v1/collections/{collection_id}', {
          params: { path: { collection_id: ids[0]! } },
        })
        if (!response.ok) throw new Error('Delete failed')
        return 1
      }
      const { data } = await api.POST('/api/v1/collections/delete', { body: { ids } })
      if (!data) throw new Error('Delete failed')
      return data.deleted
    },
    onSuccess: (_n, ids) => {
      refresh()
      ids.forEach((id) => qc.removeQueries({ queryKey: ['collection', id] }))
    },
  })
}

type Action = 'payment-page' | 'mark-paid' | 'mark-unpaid'

/** Attach or replace the payment receipt (image/PDF). Throws with the server's reason on failure. */
export function useUploadReceipt(id: string) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: async (file: File) => {
      const { data, error } = await api.PUT('/api/v1/collections/{collection_id}/receipt', {
        params: { path: { collection_id: id } },
        body: { file: '' },
        bodySerializer: fileForm(file),
      })
      if (!data) {
        const first = fieldErrors(error)[0]
        throw new Error(first?.message ?? "Couldn't attach the receipt")
      }
      return data
    },
    onSuccess: (detail) => refresh(detail),
  })
}

export function useRemoveReceipt(id: string) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.DELETE('/api/v1/collections/{collection_id}/receipt', {
        params: { path: { collection_id: id } },
      })
      if (!data) throw new Error('Remove failed')
      return data
    },
    onSuccess: (detail) => refresh(detail),
  })
}

export async function fetchReceipt(id: string): Promise<Blob | undefined> {
  const { data } = await api.GET('/api/v1/collections/{collection_id}/receipt', {
    params: { path: { collection_id: id } },
    parseAs: 'blob',
  })
  return data
}

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
