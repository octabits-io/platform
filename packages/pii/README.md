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

`MASTER_KEY` must be **cryptographically random material, not a passphrase** — HKDF derives a fixed-size key but does no password stretching, so a human-chosen value is brute-forceable no matter how it's derived. Generate one with:

```bash
openssl rand -base64 32
```

`createEnvVarMasterKeyProvider` throws at startup if the source is shorter than 32 characters. Note this is a length check only — it cannot detect a long-but-guessable passphrase, so always use a generated value.

## Scoped Key Service

Per-scope key management: lazily generates an Age keypair + blind-index HMAC
key per scope, stores them master-key-encrypted in a Drizzle table (column
shapes per [`@octabits-io/drizzle-toolkit/tenant`](../drizzle-toolkit)'s
`tenantEncryptionKeyColumns`), and serves decrypted keys through a cache.
Generic over the scope column; `createTenantKeyService` is the multi-tenant
preset (`scope: { column: 'tenantId', value: tenantId }`).

```ts
import { createScopedKeyService, createTenantKeyService } from '@octabits-io/pii';
import { createLruCacheService } from '@octabits-io/foundation/utils';

const keyService = createScopedKeyService({
  db,                                        // structural: insert/delete + db.query
  scope: { column: 'orgId', value: orgId },  // or use the tenant preset below
  masterKeyProvider,
  table: schema.orgEncryptionKey,            // your encryption-key table
  tableName: 'orgEncryptionKey',             // its key in db.query
  cache,                                     // e.g. LRU with ~5-minute TTL
});

// Multi-tenant preset — same service, scope bound to the tenantId column:
const tenantKeys = createTenantKeyService({ db, tenantId, masterKeyProvider, table, tableName, cache });

const keys = await keyService.getKeys();     // lazy-generates on first use
// keys.value: { recipient, identity, blindIndexKey, keyVersion }

await keyService.generateKeyPair();          // explicit generation (e.g. at scope creation, in a tx)
await keyService.hasKeys();
await keyService.destroyKeys();              // crypto-shredding: delete key row + drop cache
keyService.invalidateCache();
```

Errors are `Result`-typed: `scoped_keys_not_found`, `scoped_key_generation_error`, or a `MasterKeyError`.

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
