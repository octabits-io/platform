import { hmac } from "@noble/hashes/hmac.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { X25519Identity, X25519Recipient } from "./recipients.js"
import { encodeHeader, encodeHeaderNoMAC, parseHeader, Stanza } from "./format.js"
import { decryptSTREAM, encryptSTREAM } from "./stream.js"
import { readAll, stream, read, readAllString, prepend } from "./io.js"

export { generateIdentity, identityToRecipient } from "./recipients.js"
export * as armor from "./armor.js"

const encoder = new TextEncoder()
const INFO_HEADER = encoder.encode("header")
const INFO_PAYLOAD = encoder.encode("payload")

interface Recipient {
    wrapFileKey(fileKey: Uint8Array): Stanza[] | Promise<Stanza[]>;
}

interface Identity {
    unwrapFileKey(stanzas: Stanza[]): Uint8Array | null | Promise<Uint8Array | null>;
}

/**
 * Encrypts data using age encryption (X25519 + ChaCha20-Poly1305).
 */
export class Encrypter {
    private recipients: Recipient[] = []

    /**
     * Add a recipient to encrypt the data for.
     * @param s - The recipient string (age1...)
     */
    addRecipient(s: string): void {
        this.recipients.push(new X25519Recipient(s))
    }

    /**
     * Encrypt data for the configured recipients.
     * @param file - The data to encrypt (string or Uint8Array)
     * @returns The encrypted data as Uint8Array
     */
    async encrypt(file: Uint8Array | string): Promise<Uint8Array> {
        const fileKey = randomBytes(16)
        const stanzas: Stanza[] = []

        for (const recipient of this.recipients) {
            stanzas.push(...await recipient.wrapFileKey(fileKey))
        }

        const hmacKey = hkdf(sha256, fileKey, undefined, INFO_HEADER, 32)
        const mac = hmac(sha256, hmacKey, encodeHeaderNoMAC(stanzas))
        const header = encodeHeader(stanzas, mac)

        const nonce = randomBytes(16)
        const streamKey = hkdf(sha256, fileKey, nonce, INFO_PAYLOAD, 32)
        const encrypter = encryptSTREAM(streamKey)

        if (typeof file === "string") file = encoder.encode(file)
        return await readAll(prepend(stream(file).pipeThrough(encrypter), header, nonce))
    }
}

/**
 * Decrypts data using age encryption.
 */
export class Decrypter {
    private identities: Identity[] = []

    /**
     * Add an identity to decrypt with.
     * @param s - The identity string (AGE-SECRET-KEY-1...)
     */
    addIdentity(s: string): void {
        this.identities.push(new X25519Identity(s))
    }

    /**
     * Decrypt data using the configured identities.
     * @param file - The encrypted data
     * @param outputFormat - Output format: "uint8array" (default) or "text"
     * @returns The decrypted data
     */
    async decrypt(file: Uint8Array, outputFormat?: "uint8array"): Promise<Uint8Array>
    async decrypt(file: Uint8Array, outputFormat: "text"): Promise<string>
    async decrypt(file: Uint8Array, outputFormat?: "text" | "uint8array"): Promise<string | Uint8Array> {
        const s = stream(file)
        const h = await parseHeader(s)
        const fileKey = await this.unwrapFileKey(h.stanzas)
        if (fileKey === null) throw Error("no identity matched any of the file's recipients")

        const hmacKey = hkdf(sha256, fileKey, undefined, INFO_HEADER, 32)
        const mac = hmac(sha256, hmacKey, h.headerNoMAC)
        if (!compareBytes(h.MAC, mac)) throw Error("invalid header HMAC")

        const { data: nonce, rest: payload } = await read(h.rest, 16)
        const streamKey = hkdf(sha256, fileKey, nonce, INFO_PAYLOAD, 32)
        const decrypter = decryptSTREAM(streamKey)
        const out = payload.pipeThrough(decrypter)

        if (outputFormat === "text") return await readAllString(out)
        return await readAll(out)
    }

    private async unwrapFileKey(stanzas: Stanza[]): Promise<Uint8Array | null> {
        for (const identity of this.identities) {
            const fileKey = await identity.unwrapFileKey(stanzas)
            if (fileKey !== null) return fileKey
        }
        return null
    }
}

function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) { return false }
    let acc = 0
    for (let i = 0; i < a.length; i++) {
        acc |= (a[i] ?? 0) ^ (b[i] ?? 0)
    }
    return acc === 0
}
