import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FORBIDDEN = /SERVICE_ROLE|TOKEN_ENC|TOKEN_HMAC|ANTHROPIC|sk-ant-|DATABASE_URL|JWT_SECRET/i

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('frontend holds public values only', () => {
  it('.env.example and source never reference backend-only secrets', () => {
    const files = [...walk('src').filter((f) => !f.endsWith('public-env.test.ts')), '.env.example']
    const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('only VITE_ variables are declared for the browser', () => {
    const declared = readFileSync('.env.example', 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0])
    expect(declared.every((n) => n?.startsWith('VITE_'))).toBe(true)
  })
})
