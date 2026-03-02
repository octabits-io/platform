// Service factories
export { createPiiEncryptionService, createPiiEncryptionOnlyService } from './pii-service.ts';
export type { PiiEncryptionService, PiiEncryptionOnlyService, PiiEncryptionServiceDeps, PiiEncryptionOnlyServiceDeps } from './pii-service.ts';

// Master key
export { createEnvVarMasterKeyProvider } from './master-key.ts';
export type { MasterKeyProvider, MasterKeyError } from './master-key.ts';

// Blind index
export { createBlindIndex, createBlindIndexService } from './blind-index.ts';
export type { BlindIndexService } from './blind-index.ts';

// Error types
export type { PiiEncryptionError, PiiDecryptionError } from './pii-encryption.ts';

// Low-level (for advanced use)
export { encryptHybrid, decryptHybrid, encryptSymmetric, decryptSymmetric, generateSymmetricKey } from './encryption.ts';
export type { SymmetricEncryptionError, HybridEncryptionError, HybridDecryptionError, InvalidFormatError } from './encryption.ts';

// Age encryption primitives
export { Encrypter, Decrypter, generateIdentity, identityToRecipient } from './typage/index.ts';
