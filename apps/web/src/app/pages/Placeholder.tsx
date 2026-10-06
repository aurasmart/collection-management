import type { ReactNode } from 'react'
import { Card, EmptyState } from '@/components/ui'

/** Phase 0 stand-in for screens that are built in later phases. Contains no business logic. */
export function PlaceholderPage({
  title,
  phase,
  children,
}: {
  title: string
  phase: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Card>
        <EmptyState
          title={`${title} is coming soon`}
          description={`This screen is built in ${phase}.`}
        />
      </Card>
      {children}
    </div>
  )
}
