import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { kitMessagesEn } from '@octabits-io/nuxt-ui-kit/i18n'
import en from '../locales/en.json'
import { i18n } from './i18n'

/**
 * The merge in `~/lib/i18n`. Its failure mode is the worst kind: nothing
 * throws, and a component renders `pageChrome.help` as literal text in the UI.
 */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { [prefix]: value }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
    (acc, [key, child]) => Object.assign(acc, flatten(child, prefix ? `${prefix}.${key}` : key)),
    {},
  )
}

const merged = flatten(i18n.global.getLocaleMessage('en'))

describe('merged messages', () => {
  it('carries every key the kit provides', () => {
    const missing = Object.keys(flatten(kitMessagesEn)).filter((key) => !(key in merged))
    expect(missing).toEqual([])
  })

  it('carries every key this app provides', () => {
    const missing = Object.keys(flatten(en)).filter((key) => !(key in merged))
    expect(missing).toEqual([])
  })

  it('lets the app override kit copy within a shared namespace', () => {
    // `errors.forbidden` is demo-specific (it names the role switch); the kit's
    // default for a key the app does NOT override has to survive the same merge.
    expect(merged['errors.forbidden']).toBe(en.errors.forbidden)
    expect(merged['errors.forbidden']).not.toBe(kitMessagesEn.errors.forbidden)
    expect(merged['errors.unique_violation']).toBe(kitMessagesEn.errors.unique_violation)
    // Both halves of `ai` survive: the kit's review card and this app's brief.
    expect(merged['ai.review.apply']).toBe(kitMessagesEn.ai.review.apply)
    expect(merged['ai.brief.action']).toBe(en.ai.brief.action)
  })

  it('resolves every key the app source actually asks for', () => {
    // Catches a locale key deleted (or renamed) without its call site — the
    // 2026-08-31 sweep deleted the app's duplicates of the kit's key set.
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          sources.push(readFileSync(path, 'utf8'))
        }
      }
    }
    walk(new URL('..', import.meta.url).pathname)

    const used = new Set<string>()
    for (const source of sources) {
      for (const match of source.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        used.add(match[1]!)
      }
    }
    expect(used.size).toBeGreaterThan(30)

    const unresolved = [...used].filter((key) => !(key in merged)).sort()
    expect(unresolved).toEqual([])
  })
})
