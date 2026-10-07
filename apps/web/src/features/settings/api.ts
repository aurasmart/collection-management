import { useQuery } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { api, fieldErrors, isReauthRequired, type ApiFieldError } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'
import type { SettingsPayload } from '@/features/settings/schema'

export type PaymentSettings = components['schemas']['PaymentSettingsOut']

export type QrAction = { kind: 'none' } | { kind: 'upload'; file: File } | { kind: 'remove' }

export const SETTINGS_KEY = ['payment-settings'] as const

export function usePaymentSettings() {
  const { status } = useAuth()
  return useQuery({
    queryKey: SETTINGS_KEY,
    enabled: status === 'signed-in',
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings/payment')
      if (error || !data) throw new Error('Could not load payment settings')
      return data
    },
  })
}

/** The QR is private: fetch it with the session token and hand the <img> a blob URL. */
export function usePaymentQrUrl(hasQr: boolean, version: string | null) {
  return useQuery({
    queryKey: ['payment-qr', version],
    enabled: hasQr,
    gcTime: 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings/payment/qr', { parseAs: 'blob' })
      if (error || !data) throw new Error('Could not load the QR image')
      return URL.createObjectURL(data)
    },
  })
}

export type SaveResult<T = PaymentSettings> =
  | { ok: true; data: T }
  | { ok: false; kind: 'validation'; errors: ApiFieldError[]; qrApplied: boolean }
  | { ok: false; kind: 'reauth'; qrApplied: boolean }
  | { ok: false; kind: 'failed'; qrApplied: boolean }

/**
 * Upload-then-save, or save-then-remove, so "enable QR" always sees the right QR state on the server.
 * The caller has already completed password confirmation; the server enforces it regardless.
 */
export async function savePaymentSettings(
  payload: SettingsPayload,
  qr: QrAction,
): Promise<SaveResult> {
  let qrApplied = false
  try {
    if (qr.kind === 'upload') {
      const r = await api.PUT('/api/v1/settings/payment/qr', {
        // The OpenAPI type is a string for binary fields; the serializer sends real multipart data.
        body: { file: '' },
        bodySerializer: () => {
          const fd = new FormData()
          fd.append('file', qr.file)
          return fd
        },
      })
      const fail = classify(r.error, r.response.status, false)
      if (fail) return fail
      qrApplied = true
    }
    const put = await api.PUT('/api/v1/settings/payment', { body: payload })
    const putFail = classify(put.error, put.response.status, qrApplied)
    if (putFail) return putFail
    let data = put.data as PaymentSettings
    if (qr.kind === 'remove') {
      const del = await api.DELETE('/api/v1/settings/payment/qr')
      const delFail = classify(del.error, del.response.status, true)
      if (delFail) return delFail
      data = del.data as PaymentSettings
    }
    return { ok: true, data }
  } catch {
    return { ok: false, kind: 'failed', qrApplied }
  }
}

export function classify(
  error: unknown,
  status: number,
  qrApplied: boolean,
): Exclude<SaveResult<never>, { ok: true }> | null {
  if (!error) return null
  if (status === 403 && isReauthRequired(error)) return { ok: false, kind: 'reauth', qrApplied }
  if (status === 422) {
    return { ok: false, kind: 'validation', errors: fieldErrors(error), qrApplied }
  }
  return { ok: false, kind: 'failed', qrApplied }
}
