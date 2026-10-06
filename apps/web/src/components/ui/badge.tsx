import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { STATUS, type StatusKey } from '@/components/ui/status'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'ocr'

const tones: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-neutral',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  ocr: 'bg-ocr-soft text-ocr',
}

export function Badge({
  tone = 'neutral',
  outline = false,
  children,
  className,
}: {
  tone?: Tone
  outline?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap',
        outline ? 'border border-current bg-surface' : '',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ status, detail }: { status: StatusKey; detail?: string }) {
  const { label, tone, icon: Icon, ...rest } = STATUS[status]
  return (
    <Badge tone={tone} outline={'outline' in rest && rest.outline}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
      {detail && <span className="font-normal">· {detail}</span>}
    </Badge>
  )
}
