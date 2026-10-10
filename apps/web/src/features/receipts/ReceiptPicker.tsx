import { useId, useRef } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { RECEIPT_ACCEPT, receiptProblem } from '@/lib/receipt'

/** Choose one receipt file (image or PDF). Shows the chosen name and a way to clear it. */
export function ReceiptPicker({
  file,
  onChange,
  onProblem,
  label = 'Attach receipt',
  disabled = false,
}: {
  file: File | null
  onChange: (file: File | null) => void
  /** Called with a message when the chosen file can't be used, or null when it is fine. */
  onProblem?: (message: string | null) => void
  label?: string
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const id = useId()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={input}
        id={id}
        type="file"
        accept={RECEIPT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null
          e.target.value = '' // so choosing the same file again still fires
          if (!chosen) return
          const problem = receiptProblem(chosen)
          onProblem?.(problem)
          if (!problem) onChange(chosen)
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip className="size-4" aria-hidden="true" />
        {file ? 'Change file' : label}
      </Button>
      {file && (
        <span className="inline-flex min-w-0 items-center gap-1 text-sm text-ink-2">
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <button
            type="button"
            aria-label="Remove chosen file"
            disabled={disabled}
            className="grid size-8 shrink-0 place-items-center rounded-control hover:bg-neutral-soft"
            onClick={() => {
              onChange(null)
              onProblem?.(null)
            }}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  )
}
