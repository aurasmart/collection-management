import { useQuery } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { api } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { classify, type SaveResult } from '@/features/settings/api'
import type { CompanyPayload } from '@/features/settings/companySchema'

export type CompanyProfile = components['schemas']['CompanyProfileOut']

export type LogoAction = { kind: 'none' } | { kind: 'upload'; file: File } | { kind: 'remove' }

export const COMPANY_KEY = ['company-profile'] as const

export function useCompanyProfile() {
  const { status } = useAuth()
  return useQuery({
    queryKey: COMPANY_KEY,
    enabled: status === 'signed-in',
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings/company')
      if (error || !data) throw new Error('Could not load the company profile')
      return data
    },
  })
}

/** The logo is private: fetch it with the session token and hand the <img> a blob URL. */
export function useCompanyLogoUrl(hasLogo: boolean, version: string | null) {
  return useQuery({
    queryKey: ['company-logo', version],
    enabled: hasLogo,
    gcTime: 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings/company/logo', { parseAs: 'blob' })
      if (error || !data) throw new Error('Could not load the logo')
      return URL.createObjectURL(data)
    },
  })
}

/** Upload-then-save, or save-then-remove, mirroring the payment details flow. */
export async function saveCompanyProfile(
  payload: CompanyPayload,
  logo: LogoAction,
): Promise<SaveResult<CompanyProfile>> {
  let applied = false
  try {
    if (logo.kind === 'upload') {
      const r = await api.PUT('/api/v1/settings/company/logo', {
        body: { file: '' },
        bodySerializer: () => {
          const fd = new FormData()
          fd.append('file', logo.file)
          return fd
        },
      })
      const fail = classify(r.error, r.response.status, false)
      if (fail) return fail
      applied = true
    }
    const put = await api.PUT('/api/v1/settings/company', { body: payload })
    const putFail = classify(put.error, put.response.status, applied)
    if (putFail) return putFail
    let data = put.data as CompanyProfile
    if (logo.kind === 'remove') {
      const del = await api.DELETE('/api/v1/settings/company/logo')
      const delFail = classify(del.error, del.response.status, true)
      if (delFail) return delFail
      data = del.data as CompanyProfile
    }
    return { ok: true, data }
  } catch {
    return { ok: false, kind: 'failed', qrApplied: applied }
  }
}
