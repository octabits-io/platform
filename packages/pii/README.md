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
key per scope, stores them master-key-encrypted, and serves decrypted keys
through a cache. Generic over the scope column — the consumer picks it. A
multi-tenant consumer binds the scope to its own `tenantId` column
(`scope: { column: 'tenantId', value: tenantId }`); a single-tenant or
differently-partitioned consumer picks `orgId`, `workspaceId`, `ownerId`, ….

**Storage is a structural seam, not a database.** The service depends on a
four-method `ScopedKeyStore` (`insert` / `find` / `exists` / `destroy`),
scope-bound at construction — it owns the encryption logic and knows nothing
about SQL, drivers, or ORMs (so `@octabits-io/pii` has **no `drizzle-orm`
peer**). The Postgres/Drizzle implementation of the seam ships separately as
`createDrizzleScopedKeyStore` in
[`@octabits-io/drizzle-toolkit/scoped-key-store`](../drizzle-toolkit) (column
shapes per that package's `encryptionKeyColumns` + a consumer-declared,
**unique** scope column); provide your own store to back it with anything else.

```ts
import { createScopedKeyService } from '@octabits-io/pii';
import { createDrizzleScopedKeyStore } from '@octabits-io/drizzle-toolkit/scoped-key-store';

const scope = { column: 'orgId', value: orgId };  // consumer-chosen scope column
// A multi-tenant consumer binds the scope to its own tenantId column instead:
// const scope = { column: 'tenantId', value: tenantId };

const store = createDrizzleScopedKeyStore({
  db,                             // structural Drizzle db (select/insert/delete)
  table: schema.orgEncryptionKey, // your encryption-key table
  scope,                          // same scope the service is bound to
});

const keyService = createScopedKeyService({
  store,
  scope,
  masterKeyProvider,
  cache,                          // e.g. LRU with ~5-minute TTL
});

const keys = await keyService.getKeys();     // lazy-generates on first use
// keys.value: { recipient, identity, blindIndexKey, keyVersion }

// Explicit generation inside the caller's transaction — re-bind the store to
// the tx so the write joins it. The cache is NOT pre-populated (the tx may
// still roll back); the next getKeys() populates it.
await db.transaction(async (tx) => {
  await keyService.generateKeyPair(store.withDb(tx));
});

await keyService.hasKeys();                  // Result<boolean, ScopedKeyError>
await keyService.destroyKeys();              // crypto-shredding: delete key row + drop cache
keyService.invalidateCache();
```

The store maps its failures to two neutral outcomes — a lost unique race
(`scoped_key_store_conflict`, drives concurrent-generation recovery) vs any
other failure (`scoped_key_store_failure`) — which the service translates to its
`Result`-typed public errors: `scoped_keys_not_found`,
`scoped_key_generation_error`, `scoped_key_storage_error`, or a master-key error
(`master_key_error` / `master_key_unsupported_plaintext`).

Cache entries are keyed by `column:value` (URI-encoded). Don't share one cache instance across services whose stores persist keys in different tables under the same scope column and value — use one cache per key store.

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
