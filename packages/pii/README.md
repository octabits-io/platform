# @octabits-io/pii

Encryption toolkit for Personally Identifiable Information (PII). Uses [age encryption](https://age-encryption.org/) (X25519 + ChaCha20-Poly1305) with a built-in TypeScript implementation.

## PII Encryption Service

High-level service for encrypting/decrypting PII fields. Inject once with keys, use everywhere.

```ts
import { createPiiEncryptionService, createPiiEncryptionOnlyService } from '@octabits-io/pii';

// Full encrypt + decrypt (backend services with access to the secret key)
const pii = createPiiEncryptionService({
  recipient: 'age1...', // public key
  identity: 'AGE-SECRET-KEY-1...', // private key
});

const encrypted = await pii.encryptString('john@example.com');
const decrypted = await pii.decryptString(encrypted.value);

// JSON values with Zod validation on decrypt
const encJson = await pii.encryptJson({ street: '123 Main St', city: 'Berlin' });
const decJson = await pii.decryptJson(encJson.value, AddressSchema);

// Encrypt-only variant (e.g., ingestion services that don't need to read PII)
const encryptOnly = createPiiEncryptionOnlyService({ recipient: 'age1...' });
```

All methods return `Result<T, PiiEncryptionError | PiiDecryptionError>` and pass through `null`/`undefined` inputs.

## Blind Index

HMAC-SHA256 blind indexes for exact-match search on encrypted fields without exposing plaintext.

```ts
import { createBlindIndexService } from '@octabits-io/pii';

const blindIndex = createBlindIndexService(process.env.BLIND_INDEX_KEY);

// Store alongside encrypted data for lookups
const emailIndex = blindIndex.generateIndex('john@example.com'); // Buffer (HMAC-SHA256)

// Later: WHERE email_blind_index = $1
```

## Master Key Provider

Envelope encryption pattern — encrypt data keys at rest with a master key derived via HKDF-SHA256.

```ts
import { createEnvVarMasterKeyProvider } from '@octabits-io/pii';

const masterKey = createEnvVarMasterKeyProvider(process.env.MASTER_KEY);

const wrapped = await masterKey.encrypt(dataKeyBuffer);
const unwrapped = await masterKey.decrypt(wrapped.value);
```

## Low-Level Primitives

```ts
import { encryptHybrid, decryptHybrid } from '@octabits-io/pii';
import { encryptSymmetric, decryptSymmetric, generateSymmetricKey } from '@octabits-io/pii';

// Age encryption (X25519 + ChaCha20-Poly1305)
const encrypted = await encryptHybrid('plaintext', 'age1...');
const decrypted = await decryptHybrid(encrypted.value, 'AGE-SECRET-KEY-1...');

// AES-256-GCM symmetric encryption
const key = generateSymmetricKey();
const enc = encryptSymmetric('plaintext', key);
const dec = decryptSymmetric(enc.value, key);
```
