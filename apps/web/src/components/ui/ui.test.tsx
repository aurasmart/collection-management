import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  Alert,
  Button,
  ConfirmDialog,
  STATUS,
  StatusBadge,
  TextField,
  ToastProvider,
  useToast,
  type StatusKey,
} from '@/components/ui'

describe('Button', () => {
  it('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
  it('loading blocks clicks and exposes aria-busy', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Saving…
      </Button>,
    )
    const btn = screen.getByRole('button', { name: /saving/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
  it('defaults to type=button so it never submits a form by accident', () => {
    render(<Button>Go</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })
})

describe('TextField', () => {
  it('wires label, helper and error for assistive tech', () => {
    render(
      <TextField
        label="Amount received"
        required
        helper="Outstanding: ₹10,000.00"
        error="Too high"
      />,
    )
    const input = screen.getByLabelText(/amount received/i)
    expect(input).toBeRequired()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(/outstanding.*too high/i)
  })
})

describe('StatusBadge', () => {
  it('every status has a text label (colour is never the only signal)', () => {
    for (const key of Object.keys(STATUS) as StatusKey[]) {
      const { unmount } = render(<StatusBadge status={key} />)
      expect(screen.getByText(STATUS[key].label)).toBeInTheDocument()
      unmount()
    }
  })
  it('covers the approved stored + derived statuses and request notices only', () => {
    const labels = Object.values(STATUS).map((s) => s.label)
    for (const l of ['Pending', 'Sent', 'Paid', 'Cancelled', 'Overdue', 'Partially paid']) {
      expect(labels).toContain(l)
    }
    expect(labels).toContain('Out of date')
    expect(labels).toContain('Balance changed')
  })
  it('shows detail text', () => {
    render(<StatusBadge status="partially-paid" detail="₹4,000.00 paid" />)
    expect(screen.getByText(/₹4,000.00 paid/)).toBeInTheDocument()
  })
})

describe('Alert', () => {
  it('uses role=alert for errors and role=status for info', () => {
    render(
      <>
        <Alert tone="error" title="Boom" />
        <Alert tone="info" title="FYI" />
      </>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Boom')
    expect(screen.getByRole('status')).toHaveTextContent('FYI')
  })
})

function Harness({ destructive }: { destructive: boolean }) {
  const [open, setOpen] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Void this payment?"
      description="It will no longer be counted."
      confirmLabel="Void payment"
      destructive={destructive}
      onConfirm={() => setOpen(false)}
    />
  )
}

describe('ConfirmDialog', () => {
  it('destructive confirmations start with focus on the safe (Cancel) action', async () => {
    render(<Harness destructive />)
    expect(await screen.findByRole('dialog', { name: 'Void this payment?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Void payment' })).toBeInTheDocument()
  })
  it('closes on Cancel', async () => {
    render(<Harness destructive />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

function ToastDemo() {
  const { toast } = useToast()
  return <Button onClick={() => toast({ title: 'Saved', tone: 'success' })}>Fire</Button>
}

describe('Toast', () => {
  it('announces a toast', async () => {
    render(
      <ToastProvider>
        <ToastDemo />
      </ToastProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Fire' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})
