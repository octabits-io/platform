import { chacha20poly1305 } from "@noble/ciphers/chacha.js"

const chacha20poly1305Overhead = 16
const chunkSize = 64 * 1024
const chunkSizeWithOverhead = chunkSize + chacha20poly1305Overhead

/**
 * Increment the STREAM chunk counter in place.
 *
 * The 12-byte nonce is an 11-byte big-endian counter (bytes 0..10) followed by
 * the final-chunk flag (byte 11). The counter is incremented from its least
 * significant byte (index length-2) towards index 0, carrying on wrap-around —
 * matching upstream typage (`streamNonce[i]++; if (streamNonce[i] !== 0) break`).
 *
 * Each byte must be truncated to 8 bits before the carry check
 * (noUncheckedIndexedAccess forces reading the value back out of a plain
 * number, which is NOT auto-truncated the way a Uint8Array store is) —
 * otherwise the carry never propagates and the counter silently wraps every
 * 256 chunks, reusing nonces.
 *
 * Throws when the full 11-byte counter overflows, as upstream does.
 */
export function incNonce(streamNonce: Uint8Array): void {
    for (let i = streamNonce.length - 2; i >= 0; i--) {
        const v = ((streamNonce[i] ?? 0) + 1) & 0xff
        streamNonce[i] = v
        if (v !== 0) break
        if (i === 0) throw new Error("STREAM: nonce overflow")
    }
}

export function decryptSTREAM(key: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
    const streamNonce = new Uint8Array(12)
    let firstChunk = true

    const ciphertextBuffer = new Uint8Array(chunkSizeWithOverhead)
    let ciphertextBufferUsed = 0

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            while (chunk.length > 0) {
                if (ciphertextBufferUsed === ciphertextBuffer.length) {
                    const decryptedChunk = chacha20poly1305(key, streamNonce)
                        .decrypt(ciphertextBuffer)
                    controller.enqueue(decryptedChunk)
                    incNonce(streamNonce)
                    ciphertextBufferUsed = 0
                    firstChunk = false
                }
                const n = Math.min(ciphertextBuffer.length - ciphertextBufferUsed, chunk.length)
                ciphertextBuffer.set(chunk.subarray(0, n), ciphertextBufferUsed)
                ciphertextBufferUsed += n
                chunk = chunk.subarray(n)
            }
        },
        flush(controller) {
            streamNonce[11] = 1 // Last chunk flag.
            const decryptedChunk = chacha20poly1305(key, streamNonce)
                .decrypt(ciphertextBuffer.subarray(0, ciphertextBufferUsed))
            if (!firstChunk && decryptedChunk.length === 0) {
                throw new Error("final chunk is empty")
            }
            controller.enqueue(decryptedChunk)
        },
    })
}

export function encryptSTREAM(key: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
    const streamNonce = new Uint8Array(12)

    const plaintextBuffer = new Uint8Array(chunkSize)
    let plaintextBufferUsed = 0

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            while (chunk.length > 0) {
                if (plaintextBufferUsed === plaintextBuffer.length) {
                    const encryptedChunk = chacha20poly1305(key, streamNonce)
                        .encrypt(plaintextBuffer)
                    controller.enqueue(encryptedChunk)
                    incNonce(streamNonce)
                    plaintextBufferUsed = 0
                }
                const n = Math.min(plaintextBuffer.length - plaintextBufferUsed, chunk.length)
                plaintextBuffer.set(chunk.subarray(0, n), plaintextBufferUsed)
                plaintextBufferUsed += n
                chunk = chunk.subarray(n)
            }
        },
        flush(controller) {
            streamNonce[11] = 1 // Last chunk flag.
            const encryptedChunk = chacha20poly1305(key, streamNonce)
                .encrypt(plaintextBuffer.subarray(0, plaintextBufferUsed))
            controller.enqueue(encryptedChunk)
        },
    })
}
