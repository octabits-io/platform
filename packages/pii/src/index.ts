// Service factories
export { createPiiEncryptionService, createPiiEncryptionOnlyService } from './pii-service.ts';
export type { PiiEncryptionService, PiiEncryptionOnlyService, PiiEncryptionServiceDeps, PiiEncryptionOnlyServiceDeps } from './pii-service.ts';

// Master key
export { createEnvVarMasterKeyProvider, MIN_MASTER_KEY_SOURCE_LENGTH } from './master-key.ts';
export type { MasterKeyProvider, MasterKeyError, MasterKeyUnsupportedPlaintextError, MasterKeyProviderError } from './master-key.ts';

// Blind index
export { createBlindIndex, createBlindIndexService, MIN_BLIND_INDEX_KEY_LENGTH } from './blind-index.ts';
export type { BlindIndexService } from './blind-index.ts';

// Error types
export type { PiiEncryptionError, PiiDecryptionError } from './pii-encryption.ts';

// Low-level (for advanced use)
export { encryptHybrid, decryptHybrid, encryptHybridBytes, decryptHybridBytes, encryptSymmetric, decryptSymmetric, generateSymmetricKey } from './encryption.ts';
export type { SymmetricEncryptionError, HybridEncryptionError, HybridDecryptionError, InvalidFormatError } from './encryption.ts';

// Age encryption primitives
export { Encrypter, Decrypter, generateIdentity, identityToRecipient } from './typage/index.ts';

// Scoped encryption-key management (generic over the scope column)
export { createScopedKeyService } from './scoped-key-service.ts';
export type {
  ScopedKeyService,
  ScopedKeyServiceDeps,
  KeyScope,
  ScopedKeys,
  ScopedKeyCache,
  ScopedKeyStore,
  NewScopedKeyRow,
  ScopedKeyRow,
  ScopedKeyStoreError,
  ScopedKeyStoreConflictError,
  ScopedKeyStoreFailureError,
  ScopedKeyError,
  ScopedKeyNotFoundError,
  ScopedKeyGenerationError,
  ScopedKeyStorageError,
} from './scoped-key-service.ts';
