import type { ReactNode } from 'react'
import { Card } from '@/components/ui'

/** Centred card for the public auth screens (Stage 2 S1). */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-[400px]">
        <p className="mb-4 text-center text-lg font-semibold">Collections</p>
        <Card>
          <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          {children}
        </Card>
      </div>
    </main>
  )
}
