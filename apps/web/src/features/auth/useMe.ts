import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'

/** The caller's employer (server-derived from the session; no id is ever sent). */
export function useMe() {
  const { status } = useAuth()
  return useQuery({
    queryKey: ['me'],
    enabled: status === 'signed-in',
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me')
      if (error || !data) throw new Error('Could not load your workspace')
      return data.employer
    },
    staleTime: 5 * 60_000,
  })
}
