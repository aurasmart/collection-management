import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

type AlertTone = 'info' | 'success' | 'warning' | 'error'

const styles: Record<AlertTone, { box: string; icon: typeof Info }> = {
  info: { box: 'border-info bg-info-soft', icon: Info },
  success: { box: 'border-success bg-success-soft', icon: CheckCircle2 },
  warning: { box: 'border-warning bg-warning-soft', icon: AlertTriangle },
  error: { box: 'border-danger bg-danger-soft', icon: XCircle },
}

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone
  title?: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const { box, icon: Icon } = styles[tone]
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-control border-l-4 p-3', box, className)}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-ink">{children}</div>}
      </div>
      {action}
    </div>
  )
}
