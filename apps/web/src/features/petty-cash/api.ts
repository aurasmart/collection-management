import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { api, fieldErrors, type ApiFieldError } from '@/lib/api'
import { fileForm } from '@/lib/receipt'
import { useAuth } from '@/features/auth/AuthProvider'

export type PettyCashEntry = components['schemas']['PettyCashEntry']
export type PettyCashFields = components['schemas']['PettyCashFields']
export type PettyCashProposal = components['schemas']['PettyCashProposal']

export const PAGE_SIZE = 50

export function usePettyCash(q: string, page: number) {
  const { status } = useAuth()
  return useQuery({
    queryKey: ['petty-cash', q, page],
    enabled: status === 'signed-in',
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/petty-cash', {
        params: { query: { q: q || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE } },
      })
      if (error || !data) throw new Error('Could not load petty cash')
      return data
    },
  })
}

export type SaveResult<T> =
  { ok: true; data: T } | { ok: false; errors: ApiFieldError[]; message: string }

function failure(error: unknown, status: number): { errors: ApiFieldError[]; message: string } {
  const errors = fieldErrors(error)
  return {
    errors,
    message:
      errors.length || status === 422
        ? ''
        : status === 502
          ? "Couldn't store the receipt file. Check that the private 'receipts' bucket exists in Supabase Storage."
          : "Couldn't save. Please try again.",
  }
}

/** Read a receipt into proposed fields. Nothing is saved. */
export async function extractReceipt(file: File): Promise<SaveResult<PettyCashProposal>> {
  try {
    const { data, error, response } = await api.POST('/api/v1/petty-cash/extract', {
      body: { file: '' },
      bodySerializer: fileForm(file),
    })
    if (data) return { ok: true, data }
    const f = failure(error, response.status)
    return { ok: false, ...f, message: f.message && "Couldn't read the receipt. Please try again." }
  } catch {
    return { ok: false, errors: [], message: "Couldn't read the receipt. Please try again." }
  }
}

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: ['petty-cash'] })
}

export function useCreateEntry() {
  const refresh = useRefresh()
  return async (file: File, fields: PettyCashFields): Promise<SaveResult<PettyCashEntry>> => {
    try {
      const { data, error, response } = await api.POST('/api/v1/petty-cash', {
        body: { file: '', fields: '' },
        bodySerializer: fileForm(file, { fields: JSON.stringify(fields) }),
      })
      if (data) {
        refresh()
        return { ok: true, data }
      }
      return { ok: false, ...failure(error, response.status) }
    } catch {
      return { ok: false, errors: [], message: "Couldn't save. Please try again." }
    }
  }
}

export function useUpdateEntry(id: string) {
  const refresh = useRefresh()
  return async (fields: PettyCashFields): Promise<SaveResult<PettyCashEntry>> => {
    try {
      const { data, error, response } = await api.PUT('/api/v1/petty-cash/{entry_id}', {
        params: { path: { entry_id: id } },
        body: fields,
      })
      if (data) {
        refresh()
        return { ok: true, data }
      }
      return { ok: false, ...failure(error, response.status) }
    } catch {
      return { ok: false, errors: [], message: "Couldn't save. Please try again." }
    }
  }
}

export function useDeleteEntry() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) => {
      const { response } = await api.DELETE('/api/v1/petty-cash/{entry_id}', {
        params: { path: { entry_id: id } },
      })
      if (!response.ok) throw new Error('Delete failed')
    },
    onSuccess: refresh,
  })
}

export async function fetchEntryReceipt(id: string): Promise<Blob | undefined> {
  const { data } = await api.GET('/api/v1/petty-cash/{entry_id}/receipt', {
    params: { path: { entry_id: id } },
    parseAs: 'blob',
  })
  return data
}
