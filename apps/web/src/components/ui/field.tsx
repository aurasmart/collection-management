import { useId, type ComponentProps, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'prefix'> {
  label: string
  helper?: string
  /** Inline error text (shown with an icon; never colour alone). */
  error?: string
  /** Adornment inside the input, e.g. "₹". */
  prefix?: ReactNode
}

/** Labelled input with helper + error wiring (Stage 2 §24 inline validation, §27 forms). */
export function TextField({
  label,
  helper,
  error,
  prefix,
  required,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const auto = useId()
  const inputId = id ?? auto
  const helperId = `${inputId}-helper`
  const errorId = `${inputId}-error`
  const describedBy = [helper && helperId, error && errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="font-medium">
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {' '}
            *
          </span>
        )}
      </label>
      <div className="relative flex items-center">
        {prefix && (
          <span className="pointer-events-none absolute left-3 text-ink-2" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'min-h-11 w-full rounded-control border bg-surface px-3 text-base',
            prefix ? 'pl-8' : '',
            error ? 'border-danger' : 'border-field',
          )}
          {...rest}
        />
      </div>
      {helper && (
        <p id={helperId} className="text-sm text-ink-2">
          {helper}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-1 text-sm text-danger">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
