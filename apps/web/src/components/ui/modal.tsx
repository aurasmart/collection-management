import type { ReactNode, RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Responsive modal: centred dialog on >=sm, full-screen sheet on phones (Stage 2 §25/§26).
 * Radix provides focus trap, Esc to close, and focus restore.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children?: ReactNode
  footer?: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            if (initialFocusRef?.current) {
              e.preventDefault()
              initialFocusRef.current.focus()
            }
          }}
          className={cn(
            'fixed z-50 flex flex-col bg-surface shadow-modal',
            'inset-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[90vh] sm:w-full sm:max-w-lg',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-modal',
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line p-4">
            <div>
              <Dialog.Title className="text-xl font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-ink-2">{description}</Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="grid size-11 shrink-0 place-items-center rounded-control hover:bg-neutral-soft"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </header>
          {children && <div className="flex-1 overflow-y-auto p-4">{children}</div>}
          {footer && (
            <footer className="flex flex-col-reverse gap-2 border-t border-line p-4 sm:flex-row sm:justify-end">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
