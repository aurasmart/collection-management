import type { ReactNode } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { Card } from '@/components/ui'

/** Centred card for the public auth screens (Stage 2 S1). */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-[400px]">
        <div className="mb-4 flex flex-col items-center gap-2">
          <BrandMark className="size-20" />
          <p className="text-lg font-semibold">Collection Management</p>
        </div>
        <Card>
          <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          {children}
        </Card>
      </div>
    </main>
  )
}
