import { useCallback, useMemo, useState, type ReactNode } from 'react'
import * as RadixToast from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ToastContext, type ToastApi, type ToastTone } from '@/components/ui/toast-context'

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

const toneClass: Record<ToastTone, string> = {
  success: 'border-success',
  error: 'border-danger',
  info: 'border-info',
}

/** Success/info toasts auto-dismiss in 5s; errors persist until dismissed (Stage 2 §24). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const toast = useCallback<ToastApi['toast']>(({ title, description, tone = 'info' }) => {
    setItems((prev) => [
      ...prev.slice(-2),
      { id: Date.now() + Math.random(), title, description, tone },
    ])
  }, [])
  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right" label="Notifications">
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            type={t.tone === 'error' ? 'foreground' : 'background'}
            duration={t.tone === 'error' ? Infinity : 5000}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((x) => x.id !== t.id))
            }}
            className={cn(
              'flex items-start gap-3 rounded-control border-l-4 bg-surface p-3 shadow-popover',
              toneClass[t.tone],
            )}
          >
            <div className="flex-1">
              <RadixToast.Title className="font-semibold">{t.title}</RadixToast.Title>
              {t.description && (
                <RadixToast.Description className="text-ink-2">
                  {t.description}
                </RadixToast.Description>
              )}
            </div>
            <RadixToast.Close
              aria-label="Dismiss"
              className="grid size-11 shrink-0 place-items-center rounded-control hover:bg-neutral-soft"
            >
              <X className="size-4" aria-hidden="true" />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed inset-x-0 bottom-20 z-[60] mx-auto flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none sm:inset-x-auto sm:top-4 sm:right-4 sm:bottom-auto sm:mx-0" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  )
}
