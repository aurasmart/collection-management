import logo from '@/assets/latigid-logo.png'
import { cn } from '@/lib/cn'

/** The Latigid logo (the app's fixed brand mark: header, sign-in, sign-up). */
export function BrandMark({ className }: { className?: string }) {
  return <img src={logo} alt="Latigid" className={cn('object-contain', className)} />
}
