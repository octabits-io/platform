import { bech32, base64nopad } from "@scure/base"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { randomBytes } from "@noble/hashes/utils.js"
import * as x25519 from "./x25519.js"
import { Stanza } from "./format.js"

const INFO_X25519 = new TextEncoder().encode("age-encryption.org/v1/X25519")

/**
 * Generate a new age identity.
 * @returns The identity string (AGE-SECRET-KEY-1...)
 */
export function generateIdentity(): Promise<string> {
    const scalar = randomBytes(32)
    const identity = bech32.encodeFromBytes("AGE-SECRET-KEY-", scalar).toUpperCase()
    return Promise.resolve(identity)
}

/**
 * Convert an age identity to a recipient.
 * @param identity - The identity string (AGE-SECRET-KEY-1...)
 * @returns The recipient string (age1...)
 */
export async function identityToRecipient(identity: string): Promise<string> {
    const res = bech32.decodeToBytes(identity)
    if (!identity.startsWith("AGE-SECRET-KEY-1") ||
        res.prefix.toUpperCase() !== "AGE-SECRET-KEY-" ||
        res.bytes.length !== 32) { throw Error("invalid identity") }
    const recipient = await x25519.scalarMultBase(res.bytes)
    return bech32.encodeFromBytes("age", recipient)
}

export class X25519Recipient {
    private recipient: Uint8Array

    constructor(s: string) {
        const res = bech32.decodeToBytes(s)
        if (!s.startsWith("age1") ||
            res.prefix.toLowerCase() !== "age" ||
            res.bytes.length !== 32) { throw Error("invalid recipient") }
        this.recipient = res.bytes
    }

    async wrapFileKey(fileKey: Uint8Array): Promise<Stanza[]> {
        const ephemeral = randomBytes(32)
        const share = await x25519.scalarMultBase(ephemeral)
        const secret = await x25519.scalarMult(ephemeral, this.recipient)

        const salt = new Uint8Array(share.length + this.recipient.length)
        salt.set(share)
        salt.set(this.recipient, share.length)

        const key = hkdf(sha256, secret, salt, INFO_X25519, 32)
        return [new Stanza(["X25519", base64nopad.encode(share)], encryptFileKey(fileKey, key))]
    }
}

export class X25519Identity {
    private identity: Uint8Array
    private recipient: Promise<Uint8Array>

    constructor(s: string) {
        const res = bech32.decodeToBytes(s)
        if (!s.startsWith("AGE-SECRET-KEY-1") ||
            res.prefix.toUpperCase() !== "AGE-SECRET-KEY-" ||
            res.bytes.length !== 32) { throw Error("invalid identity") }
        this.identity = res.bytes
        this.recipient = x25519.scalarMultBase(res.bytes)
    }

    async unwrapFileKey(stanzas: Stanza[]): Promise<Uint8Array | null> {
        for (const s of stanzas) {
            if (s.args.length < 1 || s.args[0] !== "X25519") {
                continue
            }
            if (s.args.length !== 2) {
                throw Error("invalid X25519 stanza")
            }
            const share = base64nopad.decode(s.args[1]!)
            if (share.length !== 32) {
                throw Error("invalid X25519 stanza")
            }

            const secret = await x25519.scalarMult(this.identity, share)

            const recipient = await this.recipient
            const salt = new Uint8Array(share.length + recipient.length)
            salt.set(share)
            salt.set(recipient, share.length)

            const key = hkdf(sha256, secret, salt, INFO_X25519, 32)
            const fileKey = decryptFileKey(s.body, key)
            if (fileKey !== null) return fileKey
        }
        return null
    }
}

function encryptFileKey(fileKey: Uint8Array, key: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(12)
    return chacha20poly1305(key, nonce).encrypt(fileKey)
}

function decryptFileKey(body: Uint8Array, key: Uint8Array): Uint8Array | null {
    if (body.length !== 32) {
        throw Error("invalid stanza")
    }
    const nonce = new Uint8Array(12)
    try {
        return chacha20poly1305(key, nonce).decrypt(body)
    } catch {
        return null
    }
}
