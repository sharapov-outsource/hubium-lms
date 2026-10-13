import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

// Prepares file storage before the first start: creates the S3 bucket when it is missing.
// The local FS driver creates its directories on first write, so it needs nothing here.
const { getStorage, S3Storage } = await import('../src/files/storage.ts');

const storage = getStorage();
if (storage instanceof S3Storage) {
  const result = await storage.ensureBucket();
  console.log(`Storage: S3 bucket ${process.env.S3_BUCKET ?? 'hubium'} ${result}`);
} else {
  console.log('Storage: local filesystem, nothing to prepare');
}
