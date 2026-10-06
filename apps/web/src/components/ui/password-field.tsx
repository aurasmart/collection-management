import { forwardRef, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { TextField } from '@/components/ui/field'

type Props = Omit<ComponentProps<typeof TextField>, 'type' | 'prefix'>

/** Password input with a show/hide toggle (Stage 2 S1). */
export const PasswordField = forwardRef<HTMLInputElement, Props>(
  function PasswordField(props, ref) {
    const [shown, setShown] = useState(false)
    return (
      <div className="relative">
        <TextField
          ref={ref}
          {...props}
          type={shown ? 'text' : 'password'}
          className="[&_input]:pr-12"
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-pressed={shown}
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute top-8 right-1 grid size-11 place-items-center rounded-control text-ink-2 hover:text-ink"
        >
          {shown ? (
            <EyeOff className="size-5" aria-hidden="true" />
          ) : (
            <Eye className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>
    )
  },
)
