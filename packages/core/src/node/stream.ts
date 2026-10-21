import type { Db } from '@hubium/db';
import { log } from '@hubium/log';
import { onBusMessage } from '../cache-bus.ts';
import { SSE_HEADERS, sseEvent } from '../lib/sse.ts';
import { currentLsn } from './replication.ts';

// The bus for the nodes: a node's replica gets no NOTIFY, so the cloud sends every message
// of its bus (cache topics, realtime events) to each node as a stream, each with the WAL
// position at which the cloud had it. The node applies a message once its replica has
// replayed that far; otherwise a cache would read the old data again.

const logger = log('nodes');

export interface BusEvent {
  /** The cloud's WAL position when the message arrived: the change is at or before it. */
  lsn: string;
  /** hubium_cache, hubium_rt, or hello (the first event, with the position now) */
  c: string;
  p: string;
}

const PING_MS = 15_000;

export function nodeStream(db: Db, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending: { c: string; p: string }[] = [{ c: 'hello', p: '' }];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      // messages close together share one position: the latest, which covers them all
      const flush = async () => {
        timer = undefined;
        const batch = pending;
        pending = [];
        const lsn = await currentLsn(db);
        for (const e of batch) send(sseEvent({ lsn, ...e } satisfies BusEvent));
      };
      const schedule = () => {
        timer ??= setTimeout(() => {
          flush().catch((err) => logger.warn({ err }, 'node stream: no WAL position'));
        }, 20);
      };
      const off = onBusMessage((c, p) => {
        pending.push({ c, p });
        schedule();
      });
      const ping = setInterval(() => send(': ping\n\n'), PING_MS);
      stop = () => {
        off();
        clearInterval(ping);
        if (timer) clearTimeout(timer);
      };
      signal.addEventListener('abort', () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      send('retry: 2000\n\n');
      schedule();
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
