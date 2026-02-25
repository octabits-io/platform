import { describe, it, expect, beforeAll } from 'vitest'
import {
    Encrypter,
    Decrypter,
    generateIdentity,
    identityToRecipient,
} from './index.js'

describe('typage', () => {
    let identity: string
    let recipient: string

    beforeAll(async () => {
        identity = await generateIdentity()
        recipient = await identityToRecipient(identity)
    })

    describe('generateIdentity', () => {
        it('should generate a valid identity string', async () => {
            const id = await generateIdentity()
            expect(id).toMatch(/^AGE-SECRET-KEY-1[A-Z0-9]+$/)
        })

        it('should generate unique identities', async () => {
            const id1 = await generateIdentity()
            const id2 = await generateIdentity()
            expect(id1).not.toBe(id2)
        })
    })

    describe('identityToRecipient', () => {
        it('should convert identity to recipient', async () => {
            const id = await generateIdentity()
            const rec = await identityToRecipient(id)
            expect(rec).toMatch(/^age1[a-z0-9]+$/)
        })

        it('should reject invalid identity', async () => {
            await expect(identityToRecipient('invalid')).rejects.toThrow()
        })

        it('should reject identity with wrong prefix', async () => {
            await expect(identityToRecipient('AGE-WRONG-KEY-1abc')).rejects.toThrow()
        })
    })

    describe('Encrypter', () => {
        it('should encrypt string data', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('hello world')
            expect(encrypted).toBeInstanceOf(Uint8Array)
            expect(encrypted.length).toBeGreaterThan(0)
        })

        it('should encrypt Uint8Array data', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const data = new Uint8Array([1, 2, 3, 4, 5])
            const encrypted = await enc.encrypt(data)
            expect(encrypted).toBeInstanceOf(Uint8Array)
            expect(encrypted.length).toBeGreaterThan(data.length)
        })

        it('should encrypt empty data', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('')
            expect(encrypted).toBeInstanceOf(Uint8Array)
        })

        it('should reject invalid recipient', () => {
            const enc = new Encrypter()
            expect(() => enc.addRecipient('invalid')).toThrow()
        })

        it('should encrypt for multiple recipients', async () => {
            const id2 = await generateIdentity()
            const rec2 = await identityToRecipient(id2)

            const enc = new Encrypter()
            enc.addRecipient(recipient)
            enc.addRecipient(rec2)

            const encrypted = await enc.encrypt('secret message')
            expect(encrypted).toBeInstanceOf(Uint8Array)

            // Both recipients should be able to decrypt
            const dec1 = new Decrypter()
            dec1.addIdentity(identity)
            const plain1 = await dec1.decrypt(encrypted, 'text')
            expect(plain1).toBe('secret message')

            const dec2 = new Decrypter()
            dec2.addIdentity(id2)
            const plain2 = await dec2.decrypt(encrypted, 'text')
            expect(plain2).toBe('secret message')
        })
    })

    describe('Decrypter', () => {
        it('should decrypt to string', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('hello world')

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted, 'text')
            expect(decrypted).toBe('hello world')
        })

        it('should decrypt to Uint8Array', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const data = new Uint8Array([1, 2, 3, 4, 5])
            const encrypted = await enc.encrypt(data)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted)
            expect(decrypted).toEqual(data)
        })

        it('should decrypt empty data', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('')

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted, 'text')
            expect(decrypted).toBe('')
        })

        it('should reject wrong identity', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('secret')

            const wrongId = await generateIdentity()
            const dec = new Decrypter()
            dec.addIdentity(wrongId)

            await expect(dec.decrypt(encrypted)).rejects.toThrow(
                "no identity matched any of the file's recipients"
            )
        })

        it('should reject invalid identity', () => {
            const dec = new Decrypter()
            expect(() => dec.addIdentity('invalid')).toThrow()
        })

        it('should decrypt with multiple identities (first matches)', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('secret')

            const wrongId = await generateIdentity()
            const dec = new Decrypter()
            dec.addIdentity(identity)
            dec.addIdentity(wrongId)

            const decrypted = await dec.decrypt(encrypted, 'text')
            expect(decrypted).toBe('secret')
        })

        it('should decrypt with multiple identities (second matches)', async () => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt('secret')

            const wrongId = await generateIdentity()
            const dec = new Decrypter()
            dec.addIdentity(wrongId)
            dec.addIdentity(identity)

            const decrypted = await dec.decrypt(encrypted, 'text')
            expect(decrypted).toBe('secret')
        })
    })

    describe('round-trip', () => {
        it.each([
            ['empty string', ''],
            ['simple text', 'hello world'],
            ['unicode text', 'Hello \u4e16\u754c \ud83c\udf0d'],
            ['long text', 'a'.repeat(10000)],
            ['newlines', 'line1\nline2\nline3'],
            ['special chars', '!@#$%^&*()_+-=[]{}|;:,.<>?'],
        ])('should round-trip %s', async (_, plaintext) => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(plaintext)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted, 'text')

            expect(decrypted).toBe(plaintext)
        })

        it.each([
            ['empty array', new Uint8Array([])],
            ['single byte', new Uint8Array([42])],
            ['all zeros', new Uint8Array(100).fill(0)],
            ['all 255s', new Uint8Array(100).fill(255)],
            ['sequential', new Uint8Array(256).map((_, i) => i)],
            ['large payload', new Uint8Array(100000).fill(123)],
        ])('should round-trip %s', async (_, data) => {
            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(data)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted)

            expect(decrypted).toEqual(data)
        })

        it('should handle chunk boundary (64KB)', async () => {
            // STREAM uses 64KB chunks
            const chunkSize = 64 * 1024
            const data = new Uint8Array(chunkSize + 100).fill(42)

            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(data)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted)

            expect(decrypted).toEqual(data)
        })

        it('should handle exactly one chunk', async () => {
            const chunkSize = 64 * 1024
            const data = new Uint8Array(chunkSize).fill(42)

            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(data)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted)

            expect(decrypted).toEqual(data)
        })

        it('should handle multiple chunks', async () => {
            const chunkSize = 64 * 1024
            const data = new Uint8Array(chunkSize * 3 + 500).fill(42)

            const enc = new Encrypter()
            enc.addRecipient(recipient)
            const encrypted = await enc.encrypt(data)

            const dec = new Decrypter()
            dec.addIdentity(identity)
            const decrypted = await dec.decrypt(encrypted)

            expect(decrypted).toEqual(data)
        })
    })
})
