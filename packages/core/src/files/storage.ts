import { createReadStream, createWriteStream, type Dirent, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sign, verifySignature } from '../crypto.ts';

// Storage drivers. Keys are opaque, e.g. "blobs/01/9f/<uuid>". The bucket is never public:
// downloads go through ACL-checked routes that stream (FS) or redirect to a presigned URL (S3).

export interface StoredObject {
  size: number;
  contentType?: string;
}

export interface StorageDriver {
  readonly kind: 'fs' | 's3';
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** The objects under a prefix, with when each was last written: for reconciling the store
   *  with the rows that name its objects. */
  list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }>;
  /**
   * Short-lived URL a browser can GET. FS driver returns a signed app route. `contentType`
   * is the type the answer carries (S3), whatever the object was stored with.
   */
  signedReadUrl(
    key: string,
    opts: { ttlSeconds: number; filename?: string; inline?: boolean; contentType?: string },
  ): Promise<string>;
}

function safeJoin(root: string, key: string): string {
  const p = path.resolve(root, key);
  if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid storage key');
  return p;
}

export class FsStorage implements StorageDriver {
  readonly kind = 'fs' as const;
  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly appUrl = '',
  ) {}

  async put(key: string, body: Buffer | Readable, _contentType: string) {
    const p = safeJoin(this.root, key);
    await mkdir(path.dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) await pipeline(Readable.from([body]), createWriteStream(p));
    else await pipeline(body, createWriteStream(p));
  }
  async getStream(key: string) {
    return createReadStream(safeJoin(this.root, key));
  }
  async head(key: string) {
    try {
      const s = await stat(safeJoin(this.root, key));
      return { size: s.size };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(safeJoin(this.root, key), { force: true });
  }
  async *list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }> {
    const walk = async function* (dir: string): AsyncGenerator<{ key: string; modifiedAt: Date }> {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.isFile()) yield { key: p, modifiedAt: (await stat(p)).mtime };
      }
    };
    const root = path.resolve(this.root);
    for await (const o of walk(safeJoin(this.root, prefix)))
      yield { key: path.relative(root, o.key).split(path.sep).join('/'), modifiedAt: o.modifiedAt };
  }
  async copy(from: string, to: string) {
    const dest = safeJoin(this.root, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(safeJoin(this.root, from), dest);
  }
  async signedReadUrl(
    key: string,
    opts: { ttlSeconds: number; filename?: string; inline?: boolean },
  ) {
    const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    const payload = `${key}|${exp}|${opts.filename ?? ''}|${opts.inline ? 1 : 0}`;
    const token = Buffer.from(payload).toString('base64url');
    return `${this.appUrl}/files/blob/${token}.${sign(payload, this.secret, 'blob')}`;
  }
  /** Validates a token produced by signedReadUrl. */
  verifyToken(token: string): { key: string; filename: string; inline: boolean } | null {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const payload = Buffer.from(data, 'base64url').toString();
    if (!verifySignature(payload, sig, this.secret, 'blob')) return null;
    const [key, exp, filename, inline] = payload.split('|');
    if (!key || Number(exp) < Date.now() / 1000) return null;
    return { key, filename: filename ?? '', inline: inline === '1' };
  }
}

export interface S3Config {
  endpoint?: string;
  publicUrl?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly signer: S3Client;
  constructor(private readonly cfg: S3Config) {
    const credentials =
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        : undefined;
    // Checksums only where S3 requires them: S3-compatible servers (RustFS, MinIO, Yandex
    // Object Storage, …) do not all accept the SDK's default CRC trailers.
    const common = {
      region: cfg.region,
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    } as const;
    this.client = new S3Client({ ...common, endpoint: cfg.endpoint });
    // Signatures cover the host, so presign against the public endpoint.
    this.signer = new S3Client({ ...common, endpoint: cfg.publicUrl ?? cfg.endpoint });
  }
  /** Creates the bucket on a fresh install; the bucket stays private either way. */
  async ensureBucket(): Promise<'exists' | 'created'> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
      return 'exists';
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw e;
    }
    await this.client.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    return 'created';
  }
  async put(key: string, body: Buffer | Readable, contentType: string) {
    const params = { Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType };
    if (Buffer.isBuffer(body)) {
      await this.client.send(new PutObjectCommand(params));
      return;
    }
    // A stream has no known length, which a single PutObject needs; Upload sends small
    // streams in one request and large ones as a multipart upload.
    await new Upload({ client: this.client, params }).done();
  }
  async getStream(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return r.Body as Readable;
  }
  async head(key: string) {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async *list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }> {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of r.Contents ?? [])
        if (o.Key) yield { key: o.Key, modifiedAt: o.LastModified ?? new Date() };
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
  async copy(from: string, to: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.cfg.bucket,
        Key: to,
        CopySource: `${this.cfg.bucket}/${from}`,
      }),
    );
  }
  async signedReadUrl(
    key: string,
    opts: { ttlSeconds: number; filename?: string; inline?: boolean; contentType?: string },
  ) {
    const disposition = `${opts.inline ? 'inline' : 'attachment'}${
      opts.filename ? `; filename*=UTF-8''${encodeURIComponent(opts.filename)}` : ''
    }`;
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
        ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
      }),
      { expiresIn: opts.ttlSeconds },
    );
  }
}

let storage: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  if (storage) return storage;
  const env = process.env;
  if (env.STORAGE_DRIVER === 's3') {
    storage = new S3Storage({
      endpoint: env.S3_ENDPOINT,
      publicUrl: env.S3_PUBLIC_URL,
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'hubium',
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    });
  } else {
    const root = fsStorageRoot();
    storage = new FsStorage(root, env.APP_SECRET ?? 'dev-secret', '');
  }
  return storage;
}

/**
 * Local storage root: STORAGE_FS_ROOT, or `.storage` at the workspace root, so the web
 * app and the worker (started from different directories) share the same files.
 */
export function fsStorageRoot(env = process.env): string {
  if (env.STORAGE_FS_ROOT) return path.resolve(env.STORAGE_FS_ROOT);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, '.storage');
    const up = path.dirname(dir);
    if (up === dir) return path.resolve('.storage');
    dir = up;
  }
}

export function setStorage(s: StorageDriver | undefined): void {
  storage = s;
}
