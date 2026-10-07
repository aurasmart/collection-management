import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const ME = { employer: { id: 'e1', name: 'Acme', email: 'o@acme.test' } }

beforeEach(() => {
  fake.reset()
  fake.setSession('o@acme.test')
})

describe('Dashboard', () => {
  it('shows the four numbers and the recent collections', async () => {
    mockApi({
      'GET /api/v1/me': () => json(ME),
      'GET /api/v1/dashboard': () =>
        json({
          total_outstanding: '125000.50',
          pending_customers: 12,
          paid_amount: '45000.00',
          customers: 20,
          recent: [
            { id: 'a', customer_name: 'Rahul Sharma', amount_due: '15000.00', status: 'PENDING' },
            { id: 'b', customer_name: 'Priya Traders', amount_due: '2500.50', status: 'PAID' },
          ],
        }),
    })
    renderApp('/')
    const totals = await screen.findByRole('region', { name: 'Totals' })
    expect(await within(totals).findByText('₹1,25,000.50')).toBeInTheDocument()
    expect(within(totals).getByText('Total Outstanding').parentElement).toHaveTextContent(
      'Total Outstanding₹1,25,000.50',
    )
    expect(within(totals).getByText('Pending Customers').parentElement).toHaveTextContent(
      'Pending Customers12',
    )
    expect(within(totals).getByText('Paid').parentElement).toHaveTextContent('Paid₹45,000.00')
    expect(within(totals).getByText('Customers').parentElement).toHaveTextContent('Customers20')
    const recent = screen.getByRole('heading', { name: 'Recent Collections' }).closest('section')!
    expect(within(recent).getByRole('link', { name: 'Rahul Sharma' })).toBeInTheDocument()
    expect(within(recent).getByText('₹2,500.50')).toBeInTheDocument()
    expect(within(recent).getByText('Pending')).toBeInTheDocument()
    expect(within(recent).getByText('Paid')).toBeInTheDocument()
  })

  it('welcomes a new employer with an upload prompt', async () => {
    mockApi({
      'GET /api/v1/me': () => json(ME),
      'GET /api/v1/dashboard': () =>
        json({
          total_outstanding: '0.00',
          pending_customers: 0,
          paid_amount: '0.00',
          customers: 0,
          recent: [],
        }),
    })
    renderApp('/')
    expect(await screen.findByText('No customers yet')).toBeInTheDocument()
    expect(screen.getAllByText('₹0.00', { selector: 'p' })).toHaveLength(2) // outstanding and paid
    expect(screen.getAllByRole('link', { name: 'Upload customers' }).length).toBeGreaterThan(0)
  })

  it('shows an error with Retry', async () => {
    mockApi({ 'GET /api/v1/me': () => json(ME), 'GET /api/v1/dashboard': () => json({}, 500) })
    renderApp('/')
    expect(await screen.findByText("Couldn't load your dashboard")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
