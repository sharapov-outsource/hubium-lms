import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { Node } from '@hubium/db';
import { z } from 'zod';
import { getStorage } from '../files/storage.ts';

// Files for the nodes: each node copies the cloud's files to its own disk (its agent asks
// for what it lacks) and, after working without a connection, sends the files it stored
// then. The cloud gives files to its nodes at most NODE_FILES_MBIT megabits a second in
// all, so that the first copies of new nodes leave the line to the people working from
// home (0: no limit).

const KEY = /^(blobs|mod)\/[\w./-]+$/;

const keyOf = (url: URL) => {
  const key = url.searchParams.get('key') ?? '';
  if (!KEY.test(key) || key.includes('..')) throw new z.ZodError([]);
  return key;
};

/** One bucket for every node: the cloud's line is one. */
class Bucket {
  private tokens = 0;
  private last = Date.now();
  constructor(private readonly bytesPerSecond: number) {}

  /** Waits until `n` bytes may go. */
  async take(n: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.bytesPerSecond,
        this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond,
      );
      this.last = now;
      if (this.tokens >= n || this.tokens >= this.bytesPerSecond) {
        this.tokens -= n;
        return;
      }
      await new Promise((ok) =>
        setTimeout(ok, Math.ceil(((n - this.tokens) / this.bytesPerSecond) * 1000)),
      );
    }
  }
}

let bucket: Bucket | null | undefined;
function filesBucket(): Bucket | null {
  if (bucket === undefined) {
    const mbit = Number(process.env.NODE_FILES_MBIT ?? 100);
    bucket = mbit > 0 ? new Bucket((mbit * 1_000_000) / 8) : null;
  }
  return bucket;
}

function throttled(b: Bucket): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      b.take(chunk.length).then(() => done(null, chunk), done);
    },
  });
}

/** A file of the cloud's storage, for a node to copy. */
export async function nodeFileGet(url: URL): Promise<Response> {
  const key = keyOf(url);
  const storage = getStorage();
  const head = await storage.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  let stream: Readable = await storage.getStream(key);
  const b = filesBucket();
  if (b) stream = stream.pipe(throttled(b));
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(head.size),
      'cache-control': 'no-store',
    },
  });
}

/** Keys under a prefix (mod/: unpacked packages and video), a page at a time. */
export async function nodeFileList(url: URL) {
  const prefix = url.searchParams.get('prefix') ?? 'mod/';
  if (!/^mod\/[\w/-]*$/.test(prefix)) throw new z.ZodError([]);
  const after = url.searchParams.get('after') ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 5000);
  // pages need one order; FS lists in directory order
  const all: string[] = [];
  for await (const o of getStorage().list(prefix)) if (o.key > after) all.push(o.key);
  all.sort();
  const keys = all.slice(0, limit);
  return { keys, next: all.length > limit ? keys.at(-1) : null };
}

/**
 * A file a node stored while it worked without a connection, sent before the journal that
 * refers to it. Stored once: blob keys are unique, so a key already here holds the file.
 */
export async function nodeFilePut(
  _node: Node,
  url: URL,
  req: Request,
): Promise<{ stored: boolean }> {
  const key = keyOf(url);
  const storage = getStorage();
  if (await storage.head(key)) {
    await req.body?.cancel();
    return { stored: false };
  }
  const type = req.headers.get('content-type') ?? 'application/octet-stream';
  await storage.put(key, Readable.fromWeb(req.body as never), type);
  return { stored: true };
}
