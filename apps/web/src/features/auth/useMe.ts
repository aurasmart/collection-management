import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { startOnboarding } from '@/features/onboarding/onboarding'

/**
 * The caller's employer (server-derived from the session; no id is ever sent). A person who has just
 * signed up and confirmed their e-mail has a login but no workspace yet: the first request creates it
 * (the API builds it from the verified session), then everything else is refreshed.
 */
export function useMe() {
  const { status } = useAuth()
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['me'],
    enabled: status === 'signed-in',
    queryFn: async () => {
      let res = await api.GET('/api/v1/me')
      if (res.response.status === 403) {
        const setup = await api.POST('/api/v1/account/setup')
        if (!setup.data) throw new Error('Could not set up your workspace')
        if (setup.data.created) startOnboarding()
        res = await api.GET('/api/v1/me')
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' })
      }
      if (res.error || !res.data) throw new Error('Could not load your workspace')
      return res.data.employer
    },
    staleTime: 5 * 60_000,
  })
}
