// Public surface of the media module (PNT-027): the only file other modules and the apps may import.

export { MediaHttpModule } from './http/media-http.module.js';

// Object storage port and its implementations (05 §4, 09 §6)
export {
  OBJECT_STORAGE,
  ObjectStorageError,
  type ObjectStorage,
  type ObjectStorageDriver,
  type ObjectStorageFailure,
  type PresignedDownload,
  type PresignedUpload,
  type PresignDownloadOptions,
  type PresignUploadOptions,
  type PutObjectOptions,
  type StoredObjectInfo,
} from './infra/object-storage.js';
export { S3ObjectStorage, type S3ObjectStorageOptions } from './infra/s3-object-storage.js';
export {
  InMemoryObjectStorage,
  type InMemoryObjectStorageOptions,
  type InMemoryStorageOperation,
  type SimulatedHttpResponse,
  type StoredObject,
} from './infra/in-memory-object-storage.js';
export { createObjectStorage, selectObjectStorageDriver } from './infra/object-storage.factory.js';

// EXIF/GPS stripping (DEC-36)
export {
  DEFAULT_MAX_INPUT_PIXELS,
  ImageRejectedError,
  isSanitized,
  sanitizeImage,
  type ImageRejection,
  type SanitizeImageOptions,
  type SanitizedImage,
} from './infra/image-sanitizer.js';

// Reads for other modules (PNT-028 required photos, DEC-20 discard check, TicketDetail.media)
export {
  listTicketMedia,
  listUploadedPhotoKinds,
  toMediaDto,
  type MediaDto,
  type MediaQueryRunner,
} from './infra/media-queries.js';
export { PHOTO_UPLOADED_TIMELINE_TYPE } from './domain/media-events.js';
export { canReadTicketPhotos } from './domain/media-policy.js';
