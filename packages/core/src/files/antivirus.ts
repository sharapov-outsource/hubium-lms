import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { log } from '@hubium/log';
import { msg } from '@hubium/module-sdk';
import { type Env, getEnv } from '../env.ts';
import { UnavailableError, ValidationError } from '../errors.ts';

const logger = log('antivirus');

// Optional virus scanning of uploads with clamd (CLAMAV_URL). Files are streamed to clamd
// with INSTREAM before they are stored. A configured scanner that cannot be reached fails
// the upload (fail closed); files above CLAMAV_MAX_SCAN_MB are stored unscanned and logged.

/** clamd reads INSTREAM in chunks of at most StreamMaxLength; 64 KiB keeps memory flat. */
const CHUNK = 64 * 1024;

type Target = { host: string; port: number } | { path: string };
type ScanEnv = Pick<Env, 'CLAMAV_URL' | 'CLAMAV_MAX_SCAN_MB' | 'CLAMAV_TIMEOUT_MS'>;

function target(url: string): Target {
  const u = new URL(url);
  if (u.protocol === 'unix:') return { path: decodeURIComponent(u.pathname) };
  return { host: u.hostname, port: Number(u.port) || 3310 };
}

/** Sends one command and returns clamd's reply (clamd closes the connection after it). */
function clamd(
  url: string,
  timeoutMs: number,
  send: (s: Socket) => Promise<void>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = target(url);
    const s = 'path' in t ? createConnection(t.path) : createConnection(t.port, t.host);
    const chunks: Buffer[] = [];
    const reply = () => Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim();
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      // clamd may answer (e.g. a size limit) and hang up while the stream is still being sent
      if (err && !chunks.length) reject(err);
      else resolve(reply());
    };
    const timer = setTimeout(
      () => finish(new Error(`clamd did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    s.on('data', (d: Buffer) => chunks.push(d));
    s.on('end', () => finish(null));
    s.on('error', (e) => finish(e));
    s.on('connect', () => {
      send(s).catch((e: Error) => finish(e));
    });
  });
}

async function write(s: Socket, data: Buffer): Promise<void> {
  if (!s.write(data)) await once(s, 'drain');
}

/** Streams the content with INSTREAM and returns clamd's verdict line. */
async function instream(
  url: string,
  timeoutMs: number,
  source: AsyncIterable<Buffer> | Buffer[],
): Promise<string> {
  return clamd(url, timeoutMs, async (s) => {
    await write(s, Buffer.from('zINSTREAM\0'));
    for await (const chunk of source) {
      for (let i = 0; i < chunk.length; i += CHUNK) {
        const part = chunk.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        await write(s, Buffer.concat([len, part]));
      }
    }
    await write(s, Buffer.alloc(4));
  });
}

/** clamd's version string, e.g. `ClamAV 1.4.3/27791/…`; throws when it cannot be reached. */
export async function antivirusVersion(env: ScanEnv = getEnv()): Promise<string> {
  const { CLAMAV_URL, CLAMAV_TIMEOUT_MS } = env;
  if (!CLAMAV_URL) throw new Error('CLAMAV_URL is not set');
  return clamd(CLAMAV_URL, Math.min(CLAMAV_TIMEOUT_MS, 5000), (s) =>
    write(s, Buffer.from('zVERSION\0')),
  );
}

/**
 * Scans an upload before it is stored. Returns true when the content was scanned and is
 * clean, false when there is no scanner or the file is above the size limit. Throws a
 * ValidationError for malware and an UnavailableError when the scanner fails.
 */
export async function assertClean(
  content: { data: Buffer } | { filePath: string },
  meta: { name: string; size: number },
  env: ScanEnv = getEnv(),
): Promise<boolean> {
  const { CLAMAV_URL, CLAMAV_MAX_SCAN_MB, CLAMAV_TIMEOUT_MS } = env;
  if (!CLAMAV_URL) return false;
  if (meta.size > CLAMAV_MAX_SCAN_MB * 1024 * 1024) {
    logger.warn(
      { name: meta.name, size: meta.size, limitMb: CLAMAV_MAX_SCAN_MB },
      'Stored without a virus scan: the file is above CLAMAV_MAX_SCAN_MB',
    );
    return false;
  }
  const source =
    'data' in content
      ? [content.data]
      : createReadStream(content.filePath, { highWaterMark: CHUNK });
  let verdict: string;
  try {
    verdict = await instream(CLAMAV_URL, CLAMAV_TIMEOUT_MS, source);
  } catch (err) {
    logger.error({ err, name: meta.name }, 'The virus scanner could not be reached');
    throw new UnavailableError(msg('errors.files.scannerUnavailable'), err);
  }
  if (verdict === 'stream: OK') return true;
  const found = verdict.match(/^stream: (.+) FOUND$/);
  if (found) {
    logger.warn({ name: meta.name, size: meta.size, signature: found[1] }, 'Malware rejected');
    throw new ValidationError({
      file: [msg('errors.files.malwareDetected', { signature: found[1]! })],
    });
  }
  // e.g. "INSTREAM size limit exceeded. ERROR": clamd's limits are below CLAMAV_MAX_SCAN_MB
  logger.error({ name: meta.name, size: meta.size, verdict }, 'The virus scan failed');
  throw new UnavailableError(msg('errors.files.scanFailed', { verdict }));
}
