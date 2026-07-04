// @octabits-io/storage/s3 — S3-compatible object-storage provider.
//
// Talks to any S3-compatible store via an explicit `endpoint` + `forcePathStyle`
// (production: Hetzner Object Storage, EU). Requires the optional peer
// dependency `@aws-sdk/client-s3` (used purely as the S3 protocol client).
export {
  createAWSObjectStorageService,
  createAWSObjectStorageUrlProvider,
} from './providers/aws/AWSObjectStorageService';
export type {
  AWSObjectStorageService,
  AWSClientObjectStorageConfig,
  AWSObjectStorageUrlProvider,
  AWSObjectStorageUrlProviderConfig,
} from './providers/aws/AWSObjectStorageService';
