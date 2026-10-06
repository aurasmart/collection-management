import type { ReactNode } from 'react'

/** Never leave a blank screen: icon, title, one sentence, one primary action (Stage 2 §24). */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      {icon && <div className="text-ink-2">{icon}</div>}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-md text-ink-2">{description}</p>}
      {action}
    </div>
  )
}
