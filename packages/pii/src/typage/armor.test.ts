import { describe, it, expect, beforeAll } from 'vitest'
import { encode, decode } from './armor.js'
import {
    Encrypter,
    Decrypter,
    generateIdentity,
    identityToRecipient,
} from './index.js'

describe('armor', () => {
    let identity: string
    let recipient: string

    beforeAll(async () => {
        identity = await generateIdentity()
        recipient = await identityToRecipient(identity)
    })

    describe('encode', () => {
        it('should encode with correct header and footer', () => {
            const data = new Uint8Array([1, 2, 3, 4, 5])
            const armored = encode(data)

            expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----\n/)
            expect(armored).toMatch(/\n-----END AGE ENCRYPTED FILE-----\n$/)
        })

        it('should encode empty data', () => {
            const data = new Uint8Array([])
            const armored = encode(data)

            expect(armored).toBe(
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                '-----END AGE ENCRYPTED FILE-----\n'
            )
        })

        it('should encode data in 48-byte chunks (64 base64 chars per line)', () => {
            // 48 bytes = 64 base64 characters
            const data = new Uint8Array(100)
            const armored = encode(data)
            const lines = armored.split('\n')

            // header, 2 body lines (48+48+4 bytes), footer, empty
            expect(lines[0]).toBe('-----BEGIN AGE ENCRYPTED FILE-----')
            expect(lines[1]!.length).toBe(64) // First line: 48 bytes
            expect(lines[2]!.length).toBe(64) // Second line: 48 bytes
            expect(lines[3]!.length).toBeLessThanOrEqual(64) // Last line: 4 bytes
            expect(lines[4]).toBe('-----END AGE ENCRYPTED FILE-----')
        })

        it('should produce valid base64', () => {
            const data = new Uint8Array(256).map((_, i) => i)
            const armored = encode(data)
            const lines = armored.split('\n').slice(1, -2) // Remove header/footer

            for (const line of lines) {
                expect(line).toMatch(/^[A-Za-z0-9+/=]+$/)
            }
        })
    })

    describe('decode', () => {
        it('should decode valid armored data', () => {
            const original = new Uint8Array([1, 2, 3, 4, 5])
            const armored = encode(original)
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })

        it('should decode empty armored data', () => {
            const armored =
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                '-----END AGE ENCRYPTED FILE-----\n'
            const decoded = decode(armored)

            expect(decoded).toEqual(new Uint8Array([]))
        })

        it('should handle CRLF line endings', () => {
            const original = new Uint8Array([1, 2, 3, 4, 5])
            const armored = encode(original).replaceAll('\n', '\r\n')
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })

        it('should handle leading/trailing whitespace', () => {
            const original = new Uint8Array([1, 2, 3, 4, 5])
            const armored = '  \n\n' + encode(original) + '\n  \n'
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })

        it('should reject invalid header', () => {
            const armored =
                '-----BEGIN INVALID HEADER-----\n' +
                'AQIDBAU=\n' +
                '-----END AGE ENCRYPTED FILE-----\n'

            expect(() => decode(armored)).toThrow('invalid header')
        })

        it('should reject invalid footer', () => {
            const armored =
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                'AQIDBAU=\n' +
                '-----END INVALID FOOTER-----\n'

            expect(() => decode(armored)).toThrow('invalid footer')
        })

        it('should reject invalid line length (too long)', () => {
            const armored =
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                'A'.repeat(65) + '\n' +
                '-----END AGE ENCRYPTED FILE-----\n'

            expect(() => decode(armored)).toThrow('invalid line length')
        })

        it('should reject non-64-char lines in middle', () => {
            const armored =
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                'AAAA\n' + // 4 chars, not 64
                'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' + // 64 chars
                '-----END AGE ENCRYPTED FILE-----\n'

            expect(() => decode(armored)).toThrow('invalid line length')
        })

        it('should reject invalid base64 characters', () => {
            const armored =
                '-----BEGIN AGE ENCRYPTED FILE-----\n' +
                'AQID!!!!\n' +
                '-----END AGE ENCRYPTED FILE-----\n'

            expect(() => decode(armored)).toThrow('invalid base64')
        })
    })

    describe('round-trip', () => {
        it('should round-trip arbitrary data', () => {
            const original = new Uint8Array(1000).map((_, i) => i % 256)
            const armored = encode(original)
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })

        it('should round-trip exactly 48 bytes', () => {
            const original = new Uint8Array(48).fill(42)
            const armored = encode(original)
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })

        it('should round-trip exactly 96 bytes (2 lines)', () => {
            const original = new Uint8Array(96).fill(42)
            const armored = encode(original)
            const decoded = decode(armored)

            expect(decoded).toEqual(original)
        })
    })

    describe('integration with encryption', () => {
        it('should armor and de-armor encrypted data', async () => {
            const plaintext = 'Hello, World!'

            // Encrypt
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(plaintext)

            // Armor
            const armored = encode(encrypted)
            expect(armored).toContain('-----BEGIN AGE ENCRYPTED FILE-----')

            // De-armor
            const dearmored = decode(armored)
            expect(dearmored).toEqual(encrypted)

            // Decrypt
            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(dearmored, 'text')

            expect(decrypted).toBe(plaintext)
        })

        it('should work with large encrypted data', async () => {
            const plaintext = 'x'.repeat(100000)

            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(plaintext)

            const armored = encode(encrypted)
            const dearmored = decode(armored)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(dearmored, 'text')

            expect(decrypted).toBe(plaintext)
        })
    })
})
