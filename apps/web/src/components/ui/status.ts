import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Info,
  RefreshCw,
  Send,
  ScanLine,
  CircleDashed,
  CircleSlash,
  Contrast,
  XCircle,
} from 'lucide-react'
import type { Tone } from '@/components/ui/badge'

/** Every domain status = icon + text (colour is never the only signal; Stage 2 §26/§27). */
export const STATUS = {
  // Stored collection statuses
  pending: { label: 'Pending', tone: 'neutral', icon: Clock },
  sent: { label: 'Sent', tone: 'accent', icon: Send },
  paid: { label: 'Paid', tone: 'success', icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  // Derived indicators (never stored)
  overdue: { label: 'Overdue', tone: 'danger', icon: AlertCircle, outline: true },
  'partially-paid': { label: 'Partially paid', tone: 'info', icon: Contrast, outline: true },
  // Import validation
  ready: { label: 'Ready', tone: 'success', icon: CheckCircle2 },
  warning: { label: 'Warning', tone: 'warning', icon: AlertTriangle },
  error: { label: 'Error', tone: 'danger', icon: XCircle },
  note: { label: 'Note', tone: 'neutral', icon: Info },
  ocr: { label: 'OCR', tone: 'ocr', icon: ScanLine },
  duplicate: { label: 'Duplicate', tone: 'warning', icon: Copy },
  // Payment request
  'request-none': { label: 'No request', tone: 'neutral', icon: CircleDashed },
  'request-active': { label: 'Active', tone: 'success', icon: CheckCircle2 },
  'request-revoked': { label: 'Revoked', tone: 'neutral', icon: CircleSlash },
  'request-out-of-date': { label: 'Out of date', tone: 'warning', icon: AlertTriangle },
  'request-balance-changed': { label: 'Balance changed', tone: 'info', icon: RefreshCw },
} as const satisfies Record<
  string,
  { label: string; tone: Tone; icon: typeof Clock; outline?: boolean }
>

export type StatusKey = keyof typeof STATUS
