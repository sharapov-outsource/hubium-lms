import type { ServerResponse } from 'node:http';
import { SSE_HEADERS, sseData, sseEvent } from '@hubium/core/lib/sse';
import { listenDatabase } from '@hubium/core/node/listen';
import { lsnValue } from '@hubium/core/node/replication';
import type { NodeMode } from '@hubium/core/node/runtime';
import type { BusEvent } from '@hubium/core/node/stream';
import { log } from '@hubium/log';
import { cloudStream } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The bus of the node's web server(s). While connected, the messages come from the cloud's
// stream, each passed on once replica A has replayed as far as the cloud was when it had
// the message (a cache read before that would get the old data). While the node works on
// its own database (B), they come from B's NOTIFY. After a gap in either, the web servers
// are told to drop every cache ({ c: 'reset' }).

const logger = log('node-bus');

export class BusRelay {
  private readonly subscribers = new Set<ServerResponse>();
  private queue: BusEvent[] = [];
  private draining = false;
  private source: 'cloud' | 'own' | null = null;
  private stop: (() => void) | null = null;

  constructor(
    private readonly s: AgentSettings,
    private readonly replayedA: () => Promise<bigint | null>,
  ) {}

  /** Follows the mode: the cloud's stream, or the node's own database. */
  follow(mode: NodeMode): void {
    const want = mode === 'OFFLINE' || mode === 'SYNC' ? 'own' : 'cloud';
    if (this.source === want) return;
    this.stop?.();
    this.source = want;
    this.queue = [];
    this.stop = want === 'own' ? this.listenOwn() : this.listenCloud();
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, SSE_HEADERS);
    res.write('retry: 2000\n\n');
    this.subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(ping);
      this.subscribers.delete(res);
    });
  }

  private broadcast(c: string, p: string): void {
    const event = sseEvent({ c, p });
    for (const res of this.subscribers) res.write(event);
  }

  private listenCloud(): () => void {
    const abort = new AbortController();
    const loop = async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await cloudStream(this.s, 'stream', abort.signal);
          // whatever happened before this connection, the caches may hold
          this.broadcast('reset', '');
          for await (const data of sseData(res as unknown as ReadableStream<Uint8Array>)) {
            const e = JSON.parse(data) as BusEvent;
            if (e.c === 'hello') continue;
            this.queue.push(e);
            void this.drain();
          }
        } catch (err) {
          if (!abort.signal.aborted) logger.debug({ err }, 'cloud stream lost');
        }
        if (!abort.signal.aborted) await new Promise((ok) => setTimeout(ok, 2000));
      }
    };
    void loop();
    return () => abort.abort();
  }

  /** Passes on the cloud's messages the replica has caught up with, in order. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const head = this.queue[0]!;
        const replayed = await this.replayedA();
        if (replayed !== null && replayed >= lsnValue(head.lsn)) {
          this.queue.shift();
          this.broadcast(head.c, head.p);
          continue;
        }
        await new Promise((ok) => setTimeout(ok, 50));
      }
    } finally {
      this.draining = false;
    }
  }

  private listenOwn(): () => void {
    if (!this.s.databaseB) return () => {};
    return listenDatabase(
      this.s.databaseB,
      (c, p) => this.broadcast(c, p),
      () => this.broadcast('reset', ''),
    );
  }
}
