import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui/spinner'

export type ButtonVariant =
  'primary' | 'secondary' | 'tertiary' | 'destructive' | 'destructive-outline'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:bg-line disabled:text-ink-2',
  secondary:
    'bg-surface text-accent border border-accent hover:bg-accent-soft disabled:border-line disabled:text-ink-2',
  tertiary: 'text-accent hover:underline disabled:text-ink-2',
  destructive: 'bg-danger text-white hover:bg-red-800 disabled:bg-line disabled:text-ink-2',
  'destructive-outline':
    'bg-surface text-danger border border-danger hover:bg-danger-soft disabled:border-line disabled:text-ink-2',
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  /** `md` = 44px (default, touch-safe); `sm` = 40px for dense desktop tables. */
  size?: 'md' | 'sm'
  /** Shows a spinner, keeps width, blocks clicks, sets aria-busy. */
  loading?: boolean
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control px-4 font-medium transition-colors disabled:cursor-not-allowed',
        size === 'md' ? 'min-h-11' : 'min-h-10',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner label="" className="size-4" />}
      {children}
    </button>
  )
}
