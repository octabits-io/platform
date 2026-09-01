import { describe, expect, it } from 'vitest'
import { translationStatusOf } from './translationStatus'

const EN_DE = ['en', 'de'] as const

describe('translationStatusOf', () => {
  it('reports no status for a record with no public text', () => {
    // The badge hides — a green check here would claim an empty record is done.
    expect(translationStatusOf([{}, {}], EN_DE)).toBeUndefined()
    expect(translationStatusOf([undefined, null], EN_DE)).toBeUndefined()
    expect(translationStatusOf([{ en: '   ' }], EN_DE)).toBeUndefined()
  })

  it('counts one gap per field per missing locale', () => {
    expect(translationStatusOf([{ en: 'Title' }, { en: 'Body' }], EN_DE)).toEqual({
      complete: false,
      missing: { de: 2 },
    })
  })

  it('is complete when every in-use field covers every locale', () => {
    expect(
      translationStatusOf([{ en: 'Title', de: 'Titel' }, { en: 'Body', de: 'Text' }], EN_DE),
    ).toEqual({ complete: true, missing: {} })
  })

  it('ignores fields nobody has filled in — they are not in use yet', () => {
    // Only the title has been written; the untouched body is not a gap.
    expect(translationStatusOf([{ en: 'Title', de: 'Titel' }, {}], EN_DE)).toEqual({
      complete: true,
      missing: {},
    })
  })

  it('treats blank and whitespace-only values as missing', () => {
    expect(translationStatusOf([{ en: 'Title', de: '  ' }], EN_DE)).toEqual({
      complete: false,
      missing: { de: 1 },
    })
  })

  it('does not count register variants — a blank one inherits its base locale', () => {
    // `de-formal` is deliberately excluded from TRANSLATABLE_LOCALES; passing
    // it in would mark every record incomplete forever.
    expect(translationStatusOf([{ en: 'Title', de: 'Titel' }], ['en', 'de'])).toEqual({
      complete: true,
      missing: {},
    })
    expect(translationStatusOf([{ en: 'Title', de: 'Titel' }], ['en', 'de', 'de-formal'])).toEqual({
      complete: false,
      missing: { 'de-formal': 1 },
    })
  })
})
