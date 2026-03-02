import { describe, it, expect } from 'vitest';

import { isOctError, toOctError, isAbortError, tryCatch, tryCatchAsync } from './error.ts'

describe('isOctError', () => {
  it('returns true for valid OctError', () => {
    expect(isOctError({ key: 'foo', message: 'bar' })).toBe(true)
  })
  it('returns false for invalid object', () => {
    expect(isOctError({ key: 'foo' })).toBe(false)
    expect(isOctError({ message: 'bar' })).toBe(false)
    expect(isOctError(null)).toBe(false)
    expect(isOctError('string')).toBe(false)
  })
})

describe('toOctError', () => {
  it('returns OctError for valid OctError', () => {
    const err = { key: 'foo', message: 'bar' }
    expect(toOctError(err)).toEqual(err)
  })
  it('converts string to OctError', () => {
    expect(toOctError('error')).toEqual({ message: 'error', key: 'general' })
  })
  it('converts Error instance to OctError', () => {
    const error = new Error('fail')
    expect(toOctError(error)).toEqual({ message: 'fail', key: 'Error' })
  })
  it('returns general OctError for unknown', () => {
    expect(toOctError(123)).toEqual({ message: 'General error', key: 'general' })
    expect(toOctError(undefined)).toEqual({ message: 'General error', key: 'general' })
  })
})

describe('isAbortError', () => {
  it('returns true for AbortError', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isAbortError(error)).toBe(true)
  })
  it('returns false for other errors', () => {
    expect(isAbortError(new Error('fail'))).toBe(false)
    expect(isAbortError({ name: 'AbortError' })).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})

describe('tryCatch', () => {
  it('returns ok for non-throwing fn', () => {
    const result = tryCatch(() => 42)
    expect(result).toEqual({ ok: true, value: 42 })
  })

  it('catches sync throw and returns error', () => {
    const result = tryCatch(() => { throw new Error('boom') })
    expect(result).toEqual({
      ok: false,
      error: { key: 'exception', message: 'boom', cause: expect.any(Error) },
    })
  })

  it('preserves Error instance as cause', () => {
    const err = new Error('original')
    const result = tryCatch(() => { throw err })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.cause).toBe(err)
    }
  })

  it('handles string throw', () => {
    const result = tryCatch(() => { throw 'string error' })
    expect(result).toEqual({
      ok: false,
      error: { key: 'exception', message: 'string error', cause: 'string error' },
    })
  })

  it('handles unknown throw', () => {
    const result = tryCatch(() => { throw 123 })
    expect(result).toEqual({
      ok: false,
      error: { key: 'exception', message: 'An unknown error occurred', cause: 123 },
    })
  })
})

describe('tryCatchAsync', () => {
  it('returns ok for resolved promise', async () => {
    const result = await tryCatchAsync(() => Promise.resolve('hello'))
    expect(result).toEqual({ ok: true, value: 'hello' })
  })

  it('catches rejected promise', async () => {
    const result = await tryCatchAsync(() => Promise.reject(new Error('async boom')))
    expect(result).toEqual({
      ok: false,
      error: { key: 'exception', message: 'async boom', cause: expect.any(Error) },
    })
  })

  it('catches async throw', async () => {
    const result = await tryCatchAsync(async () => { throw new Error('async throw') })
    expect(result).toEqual({
      ok: false,
      error: { key: 'exception', message: 'async throw', cause: expect.any(Error) },
    })
  })
})
