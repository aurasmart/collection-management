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
          paid_customers: 8,
          overdue_amount: '30000.00',
          overdue_customers: 3,
          due_soon_amount: '12000.00',
          due_soon_customers: 2,
          top_outstanding: [
            {
              id: 'a',
              customer_name: 'Rahul Sharma',
              amount_due: '15000.00',
              status: 'PENDING',
              due_date: '2020-01-01',
            },
            {
              id: 'c',
              customer_name: 'Asha Stores',
              amount_due: '9000.00',
              status: 'PENDING',
              due_date: null,
            },
          ],
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
    expect(within(totals).getByText('12 pending · 8 paid')).toBeInTheDocument()
    const insights = screen.getByRole('region', { name: 'Insights' })
    expect(within(insights).getByText('₹30,000.00')).toBeInTheDocument()
    expect(within(insights).getByText('3 customers')).toBeInTheDocument()
    expect(within(insights).getByRole('link', { name: /Overdue/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/collections?overdue=1'),
    )
    expect(within(insights).getByText('₹12,000.00')).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: '26% of the money owed is collected' }),
    ).toBeInTheDocument()
    const top = screen.getByRole('heading', { name: 'Biggest outstanding' }).closest('section')!
    expect(within(top).getByRole('link', { name: 'Rahul Sharma' })).toBeInTheDocument()
    expect(within(top).getByText(/Overdue · 01 Jan 2020/)).toBeInTheDocument()
    expect(within(top).getByText('No due date')).toBeInTheDocument()
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
          paid_customers: 0,
          overdue_amount: '0.00',
          overdue_customers: 0,
          due_soon_amount: '0.00',
          due_soon_customers: 0,
          top_outstanding: [],
          recent: [],
        }),
    })
    renderApp('/')
    expect(await screen.findByText('No collections yet')).toBeInTheDocument()
    expect(screen.getByText('Nothing is overdue.')).toBeInTheDocument()
    expect(screen.getByText('Nothing due this week.')).toBeInTheDocument()
    expect(screen.getAllByText('₹0.00')).toHaveLength(2) // outstanding and paid
    expect(screen.getAllByRole('link', { name: 'Import customers' }).length).toBeGreaterThan(0)
  })

  it('shows an error with Retry', async () => {
    mockApi({ 'GET /api/v1/me': () => json(ME), 'GET /api/v1/dashboard': () => json({}, 500) })
    renderApp('/')
    expect(await screen.findByText("Couldn't load your dashboard")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
