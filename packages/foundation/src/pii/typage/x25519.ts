import { x25519 } from "@noble/curves/ed25519.js"

const exportable = false

async function webCryptoFallback<Return>(
    func: () => Return | Promise<Return>,
    fallback: () => Return | Promise<Return>,
): Promise<Return> {
    // We can't reliably detect X25519 support in WebCrypto in a performant way
    // because Bun implemented importKey, but not deriveBits.
    try {
        return await func()
    } catch (error) {
        if (error instanceof ReferenceError ||
            error instanceof DOMException && error.name === "NotSupportedError") {
            return await fallback()
        } else {
            throw error
        }
    }
}

export async function scalarMult(scalar: Uint8Array, u: Uint8Array): Promise<Uint8Array> {
    return await webCryptoFallback(async () => {
        const key = await importX25519Key(scalar)
        const peer = await crypto.subtle.importKey("raw", new Uint8Array(u), { name: "X25519" }, exportable, [])
        return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, key, 256))
    }, () => {
        return x25519.scalarMult(scalar, u)
    })
}

export async function scalarMultBase(scalar: Uint8Array): Promise<Uint8Array> {
    return await webCryptoFallback(async () => {
        return scalarMult(scalar, x25519.GuBytes)
    }, () => {
        return x25519.scalarMultBase(scalar)
    })
}

const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

async function importX25519Key(key: Uint8Array): Promise<CryptoKey> {
    if (key.length !== 32) {
        throw new Error("X25519 private key must be 32 bytes")
    }
    const pkcs8 = new Uint8Array([...pkcs8Prefix, ...key])
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, exportable, ["deriveBits"])
}
