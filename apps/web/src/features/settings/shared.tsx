import type { ReactNode } from 'react'
import type { Blocker } from 'react-router'
import { Card, ConfirmDialog } from '@/components/ui'
import { formatDateTime } from '@/lib/date'

export function Section({
  title,
  toggle,
  children,
}: {
  title: string
  toggle?: ReactNode
  children: ReactNode
}) {
  return (
    <Card aria-label={title} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {toggle}
      </div>
      {children}
    </Card>
  )
}

interface Change {
  at: string
  actor: string
  fields: string[]
}

export function RecentChanges({
  changes,
  myEmail,
  labels,
}: {
  changes: Change[]
  myEmail: string | null
  labels: Record<string, string>
}) {
  return (
    <Card aria-labelledby="recent-changes-title">
      <h2 id="recent-changes-title" className="text-lg font-semibold">
        Recent changes
      </h2>
      {changes.length === 0 ? (
        <p className="mt-2 text-ink-2">No changes yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {changes.map((c) => (
            <li
              key={`${c.at}-${c.fields.join()}`}
              className="flex flex-col gap-0.5 sm:flex-row sm:gap-4"
            >
              <span className="text-ink-2 sm:w-52">{formatDateTime(c.at)}</span>
              <span className="sm:w-44">{c.actor === myEmail ? 'You' : c.actor}</span>
              <span>{c.fields.map((f) => labels[f] ?? f).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-ink-2">Only field names are recorded, never the values.</p>
    </Card>
  )
}

export function UnsavedChangesDialog({ blocker, what }: { blocker: Blocker; what: string }) {
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(o) => {
        if (!o && blocker.state === 'blocked') blocker.reset()
      }}
      title="Leave without saving?"
      description={`You have unsaved changes to your ${what}.`}
      confirmLabel="Leave"
      cancelLabel="Stay"
      destructive
      onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
    />
  )
}
