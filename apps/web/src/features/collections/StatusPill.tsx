import { StatusBadge } from '@/components/ui'

/** PENDING / PAID only (icon + text, never colour alone). */
export function StatusPill({ status }: { status: 'PENDING' | 'PAID' }) {
  return <StatusBadge status={status === 'PAID' ? 'paid' : 'pending'} />
}
