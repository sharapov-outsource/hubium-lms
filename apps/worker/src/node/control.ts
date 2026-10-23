import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import { AGENT_KEY_HEADER, agentKey } from '@hubium/core/node/auth';
import type { NodeState } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import type { BusRelay } from './bus.ts';
import type { AgentSettings } from './settings.ts';

// The agent's API for the node's own servers (not the people of the network): the node's
// state, the side records of page views to send to the cloud, the bus, and the node admin's
// commands (those carry the key the web server has from APP_SECRET).

const logger = log('node-agent');

export interface ControlDeps {
  s: AgentSettings;
  state(): NodeState;
  bus: BusRelay;
  touch(item: unknown): void;
  /** A file the node's web server needs and the node lacks: fetched from the cloud. */
  fetchFile(key: string): Promise<boolean>;
  command(action: 'offline' | 'online' | 'postpone', until?: string): Promise<void>;
}

function body(req: IncomingMessage, max = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) req.destroy(new Error('too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function keyOk(req: IncomingMessage, s: AgentSettings): boolean {
  const given = Buffer.from(String(req.headers[AGENT_KEY_HEADER] ?? ''));
  const want = Buffer.from(agentKey(s.controlKey));
  return given.length === want.length && timingSafeEqual(given, want);
}

export function startControl(deps: ControlDeps): http.Server {
  const { s } = deps;
  const server = http.createServer(async (req, res) => {
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/state') return json(deps.state());
      if (req.method === 'GET' && path === '/bus') return deps.bus.subscribe(res);
      if (req.method === 'POST' && path === '/touch') {
        deps.touch(JSON.parse(await body(req)));
        return json({ ok: true });
      }
      if (req.method === 'POST' && path === '/fetch-file') {
        const { key } = JSON.parse(await body(req)) as { key: string };
        const ok = await deps.fetchFile(String(key));
        return json({ ok }, ok ? 200 : 404);
      }
      if (req.method === 'POST' && path === '/command') {
        if (!keyOk(req, s)) return json({ error: 'forbidden' }, 403);
        const { action, until } = JSON.parse(await body(req)) as {
          action: 'offline' | 'online' | 'postpone';
          until?: string;
        };
        if (!['offline', 'online', 'postpone'].includes(action))
          return json({ error: 'unknown action' }, 400);
        await deps.command(action, until);
        return json(deps.state());
      }
      if (req.method === 'GET' && path === '/healthz') return json({ status: 'ok' });
      json({ error: 'not found' }, 404);
    } catch (err) {
      logger.warn({ err }, 'control request failed');
      if (!res.headersSent) json({ error: 'bad request' }, 400);
    }
  });
  server.listen(s.controlPort, s.controlHost);
  return server;
}
