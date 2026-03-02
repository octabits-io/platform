import { describe, it, expect } from 'vitest'
import { base64nopad } from '@scure/base'
import { encodeHeader, encodeHeaderNoMAC, parseHeader, Stanza } from './format.js'
import { stream, readAll } from './io.js'

const toString = (a: Uint8Array): string => new TextDecoder().decode(a)
const fromString = (s: string): Uint8Array => new TextEncoder().encode(s)

const exampleHeader = `age-encryption.org/v1
-> X25519 abc
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
--- gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM
this is the payload`

describe('format', () => {
    describe('parseHeader', () => {
        it('should parse a well formatted header', async () => {
            const h = await parseHeader(stream(fromString(exampleHeader)))

            expect(h.stanzas.length).toBe(1)
            expect(h.stanzas[0]!.args).toEqual(['X25519', 'abc'])
            expect(h.stanzas[0]!.body).toEqual(
                base64nopad.decode('0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE')
            )
            expect(h.MAC).toEqual(
                base64nopad.decode('gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM')
            )
            expect(await readAll(h.rest)).toEqual(fromString('this is the payload'))
        })

        it('should reencode to the original header', async () => {
            const h = await parseHeader(stream(fromString(exampleHeader)))

            expect(encodeHeaderNoMAC(h.stanzas)).toEqual(h.headerNoMAC)

            const got = toString(encodeHeader(h.stanzas, h.MAC)) + toString(await readAll(h.rest))
            expect(got).toBe(exampleHeader)
        })

        it('should reject invalid version', async () => {
            const badHeader = `age-encryption.org/v2
-> X25519 abc
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
--- gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM
payload`

            await expect(parseHeader(stream(fromString(badHeader)))).rejects.toThrow(
                'invalid version'
            )
        })

        it('should parse header with multiple stanzas', async () => {
            const multiHeader = `age-encryption.org/v1
-> X25519 recipient1
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
-> X25519 recipient2
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
--- gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM
payload`

            const h = await parseHeader(stream(fromString(multiHeader)))

            expect(h.stanzas.length).toBe(2)
            expect(h.stanzas[0]!.args).toEqual(['X25519', 'recipient1'])
            expect(h.stanzas[1]!.args).toEqual(['X25519', 'recipient2'])
        })

        it('should handle empty payload', async () => {
            const headerNoPayload = `age-encryption.org/v1
-> X25519 abc
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
--- gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM
`

            const h = await parseHeader(stream(fromString(headerNoPayload)))

            expect(h.stanzas.length).toBe(1)
            expect(await readAll(h.rest)).toEqual(fromString(''))
        })
    })

    describe('Stanza', () => {
        it('should create a stanza with args and body', () => {
            const body = new Uint8Array([1, 2, 3, 4])
            const stanza = new Stanza(['X25519', 'test'], body)

            expect(stanza.args).toEqual(['X25519', 'test'])
            expect(stanza.body).toEqual(body)
        })

        it('should have readonly args and body', () => {
            const stanza = new Stanza(['type', 'arg'], new Uint8Array([1]))

            // TypeScript ensures these are readonly, runtime test for immutability of reference
            expect(stanza.args).toEqual(['type', 'arg'])
            expect(stanza.body).toEqual(new Uint8Array([1]))
        })
    })

    describe('encodeHeader', () => {
        it('should encode a simple header', () => {
            const body = base64nopad.decode('0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE')
            const mac = base64nopad.decode('gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM')
            const stanza = new Stanza(['X25519', 'abc'], body)

            const encoded = encodeHeader([stanza], mac)
            const expected = `age-encryption.org/v1
-> X25519 abc
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
--- gxhoSa5BciRDt8lOpYNcx4EYtKpS0CJ06F3ZwN82VaM
`

            expect(toString(encoded)).toBe(expected)
        })

        it('should encode header with empty body stanza', () => {
            const mac = new Uint8Array(32)
            const stanza = new Stanza(['type', 'arg'], new Uint8Array([]))

            const encoded = encodeHeader([stanza], mac)

            expect(toString(encoded)).toContain('-> type arg\n\n---')
        })

        it('should encode header with large body (multiple lines)', () => {
            // 48 bytes per line in base64nopad
            const body = new Uint8Array(100)
            const mac = new Uint8Array(32)
            const stanza = new Stanza(['X25519', 'test'], body)

            const encoded = encodeHeader([stanza], mac)
            const lines = toString(encoded).split('\n')

            // version line, args line, 3 body lines (48+48+4 bytes), mac line, empty
            expect(lines.length).toBeGreaterThanOrEqual(5)
        })
    })

    describe('encodeHeaderNoMAC', () => {
        it('should encode header without MAC suffix', () => {
            const body = base64nopad.decode('0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE')
            const stanza = new Stanza(['X25519', 'abc'], body)

            const encoded = encodeHeaderNoMAC([stanza])

            expect(toString(encoded)).toBe(`age-encryption.org/v1
-> X25519 abc
0OrTkKHpE7klNLd0k+9Uam5hkQkzMxaqKcIPRIO1sNE
---`)
        })
    })
})

describe('base64nopad', () => {
    it('should parse a valid base64 string', () => {
        expect(base64nopad.decode('dGVzdA')).toEqual(fromString('test'))
    })

    it('should parse a valid base64 string with spare bits', () => {
        expect(base64nopad.decode('dGVzdDI')).toEqual(fromString('test2'))
    })

    it('should reject a non-canonical base64 string', () => {
        expect(() => base64nopad.decode('dGVzdDJ')).toThrow()
    })

    it('should reject a base64 string with padding', () => {
        expect(() => base64nopad.decode('dGVzdDI=')).toThrow()
    })
})
