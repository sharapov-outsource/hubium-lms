import { createWriteStream, type Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setMirrorFetcher } from '@hubium/core/files/mirror';
import { fsStorageRoot } from '@hubium/core/files/storage';
import { allBlobKeys, mirrorBlobs, mirrorModulePrefixes } from '@hubium/core/node/mirror-db';
import type { NodeReplicas } from '@hubium/core/node/replicas';
import type { NodeMode } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import { cloudCall, cloudStream } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The node's copy of the cloud's files (STORAGE_DRIVER=mirror): copied ahead of time, the
// courses opened most recently first, and a file someone opens before its turn fetched at
// once. A node limited to some categories copies their files only and fetches the others
// when they are opened. Files the cloud removed go from the node too.

const logger = log('node-files');

export class FileMirror {
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly root = path.resolve(fsStorageRoot());
  private running = false;
  categoryIds: string[] = [];
  progress = { done: 0, total: 0, bytes: 0 };

  constructor(
    private readonly s: AgentSettings,
    private readonly replicas: NodeReplicas,
    private readonly mode: () => NodeMode,
  ) {
    setMirrorFetcher((key) => this.fetch(key));
  }

  private file(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }

  private async has(key: string): Promise<boolean> {
    try {
      return (await stat(this.file(key))).isFile();
    } catch {
      return false;
    }
  }

  /** Fetches a file from the cloud unless the node has it; false when it cannot. */
  fetch(key: string): Promise<boolean> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.download(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async download(key: string): Promise<boolean> {
    if (await this.has(key)) return true;
    const mode = this.mode();
    if (mode !== 'ONLINE' && mode !== 'PASSTHROUGH') return false;
    const target = this.file(key);
    const part = `${target}.part`;
    try {
      const res = await cloudStream(
        this.s,
        `files/get?key=${encodeURIComponent(key)}`,
        AbortSignal.timeout(30 * 60_000),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(res, createWriteStream(part));
      await rename(part, target);
      return true;
    } catch (err) {
      await rm(part, { force: true });
      logger.debug({ err, key }, 'file not fetched');
      return false;
    }
  }

  /** One round of copying: what is missing, then what the cloud no longer has. */
  async preload(): Promise<void> {
    if (this.running || this.mode() !== 'ONLINE') return;
    this.running = true;
    try {
      const a = this.replicas.replica;
      const blobs = await mirrorBlobs(a, this.categoryIds);
      const keys: { key: string; size: number }[] = [...blobs];
      for (const prefix of await mirrorModulePrefixes(a, this.categoryIds))
        for (const key of await this.cloudKeys(prefix)) keys.push({ key, size: 0 });
      this.progress = { done: 0, total: keys.length, bytes: 0 };
      for (const k of keys) {
        if (this.mode() !== 'ONLINE') return;
        if (await this.has(k.key)) this.progress.done++;
        else if (await this.fetch(k.key)) {
          this.progress.done++;
          this.progress.bytes += k.size;
        }
      }
      await this.removeGone(await allBlobKeys(a));
    } catch (err) {
      logger.warn({ err }, 'copying files failed; retrying later');
    } finally {
      this.running = false;
    }
  }

  private async cloudKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let after = '';
    for (;;) {
      const page = await cloudCall<{ keys: string[]; next: string | null }>(
        this.s,
        'GET',
        `files/list?prefix=${encodeURIComponent(prefix)}&after=${encodeURIComponent(after)}`,
      );
      out.push(...page.keys);
      if (!page.next) return out;
      after = page.next;
    }
  }

  /** Blobs on the node's disk the cloud no longer has. */
  private async removeGone(known: Set<string>): Promise<void> {
    const walk = async (dir: string): Promise<string[]> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.isFile() && !e.name.endsWith('.part')) out.push(p);
      }
      return out;
    };
    for (const p of await walk(path.join(this.root, 'blobs'))) {
      const key = path.relative(this.root, p).split(path.sep).join('/');
      if (!known.has(key)) await rm(p, { force: true });
    }
  }
}
