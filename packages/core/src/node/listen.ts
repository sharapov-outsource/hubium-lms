import { log } from '@hubium/log';
import pg from 'pg';
import { CACHE_CHANNEL } from '../cache-bus.ts';
import { RT_CHANNEL } from '../realtime.ts';

const logger = log('node-bus');

/**
 * Listens to the bus of a database (the node's own, while it works without a connection):
 * calls `onMessage` for each message and `onConnect` after each (re)connection, when
 * messages may have been missed. Returns how to stop.
 */
export function listenDatabase(
  connectionString: string,
  onMessage: (channel: string, payload: string) => void,
  onConnect: () => void,
): () => void {
  let stopped = false;
  let client: pg.Client | undefined;
  const retry = () => {
    client?.end().catch(() => {});
    if (!stopped) setTimeout(() => void connect(), 2000);
  };
  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString });
    client = c;
    c.on('notification', (m) => {
      if (m.payload) onMessage(m.channel, m.payload);
    });
    c.on('error', (err) => {
      logger.warn({ err }, 'bus of the node database lost');
      retry();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CACHE_CHANNEL}`);
      await c.query(`LISTEN ${RT_CHANNEL}`);
      onConnect();
    } catch (err) {
      logger.warn({ err }, 'cannot listen on the node database');
      retry();
    }
  };
  void connect();
  return () => {
    stopped = true;
    client?.end().catch(() => {});
  };
}
