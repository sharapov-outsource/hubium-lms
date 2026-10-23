import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { clientIp } from '@hubium/core/client-ip';
import { NODE_SIGNATURE_HEADER, signForward, tokenHash } from '@hubium/core/node/auth';
import { lsnValue } from '@hubium/core/node/replication';
import { NODE_MODE_HEADER, type NodeMode } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import { cloudTarget, type Target } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The node's gateway: everything the people of its network ask goes through it (behind the
// node's Caddy). While the node is connected, reading requests are answered by the node's
// web server from its replica, and changes go to the cloud, signed by the node; after a
// change the gateway asks the cloud for its WAL position, and reads from the same address
// wait until the replica has it (or go to the cloud), so people see their own changes.
// Without a connection everything is answered on the node.

const logger = log('node-gateway');

/** Paths the cloud answers whatever the method: sign-in, the APIs, uploads. */
const CLOUD_PATHS = ['/api/auth/', '/api/node/', '/api/v1/', '/api/ai/', '/api/uploads'];
/** What needs the outside world and so is not there without a connection. */
const EXTERNAL_PATHS = ['/api/node/', '/api/ai/'];

/**
 * External paths: those above and the HTTP endpoints of modules that talk to systems
 * outside Hubium (`httpExternal`: LTI, webinars); other modules' endpoints (video, exports)
 * are reads the node answers.
 */
export function externalPaths(externalModules: string[]): string[] {
  return [...EXTERNAL_PATHS, ...externalModules.map((k) => `/api/mod/${k}/`)];
}

export type Route = 'web' | 'cloud' | 'refuse-offline' | 'refuse-sync';

const isRead = (method: string) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
const under = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));

/** Who answers a request in a mode (`external`: externalPaths()). */
export function routeRequest(
  mode: NodeMode,
  method: string,
  path: string,
  external: string[] = EXTERNAL_PATHS,
  /** A server action: the node's web server refuses it in the person's language. */
  serverAction = false,
): Route {
  // the node's own page: its admins' commands go to its agent, whatever the mode
  if (path === '/node') return 'web';
  if (serverAction && (mode === 'READONLY' || mode === 'SYNC')) return 'web';
  const cloudOnly = under(path, CLOUD_PATHS) || under(path, external);
  switch (mode) {
    case 'PASSTHROUGH':
      return 'cloud';
    case 'ONLINE':
      return !isRead(method) || cloudOnly ? 'cloud' : 'web';
    case 'READONLY':
      // the session stays readable on the node; signing in waits for the connection
      if (path.startsWith('/api/auth/') && isRead(method)) return 'web';
      return !isRead(method) || cloudOnly ? 'refuse-offline' : 'web';
    case 'OFFLINE':
      return under(path, external) ? 'refuse-offline' : 'web';
    case 'SYNC':
      if (under(path, external)) return 'refuse-sync';
      return isRead(method) ? 'web' : 'refuse-sync';
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function copyHeaders(from: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    // a client's claims in the node's or the cloud's own headers go
    if (k === NODE_SIGNATURE_HEADER || k.startsWith('x-hubium-')) continue;
    out[k] = v;
  }
  return out;
}

export interface GatewayDeps {
  s: AgentSettings;
  mode(): NodeMode;
  /** Keys of modules whose HTTP endpoints talk to external systems. */
  externalModules: string[];
  /** Waits until replica A has replayed `lsn`; false when it did not in time. */
  waitForLsn(lsn: string, ms: number): Promise<boolean>;
  /** The cloud's WAL position now. */
  cloudLsn(): Promise<string>;
  /** A request to the cloud failed: the link may be down. */
  cloudUnreachable(err: unknown): void;
}

export function startGateway(deps: GatewayDeps): http.Server {
  const { s } = deps;
  const server = http.createServer((req, res) => {
    handle(deps, req, res).catch((err) => {
      logger.error({ err, path: req.url }, 'gateway failed');
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  // long uploads and event streams
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(s.gatewayPort, s.gatewayHost);
  return server;
}

/** The address of the person: from the node's Caddy (NODE_TRUSTED_PROXY_HOPS), or the socket. */
function remoteIp(req: IncomingMessage): string {
  const hops = process.env.NODE_TRUSTED_PROXY_HOPS ?? '1';
  return (
    clientIp(req.headers['x-forwarded-for'] as string | undefined, {
      TRUSTED_PROXY_HOPS: hops,
    }) ??
    req.socket.remoteAddress?.replace(/^::ffff:/, '') ??
    ''
  );
}

/** How long a person's last change holds up their reads at most. */
const CHANGE_MEMORY_MS = 60_000;
/** A change still on its way holds up reads this long (not an upload, which takes longer). */
const IN_FLIGHT_MS = 2000;

interface Address {
  /** The cloud's WAL position after the latest change from the address, once known. */
  lsn: string | null;
  /** Changes on their way: settle once their position is known (or they failed). */
  pending: Set<Promise<void>>;
  /** When a change was last sent or answered: reads wait for it from then on. */
  since: number;
}

/**
 * The changes made from each address, for the reads that follow them: from the pages of
 * the app, from the content origin (SCORM, H5P), the side records of page views (an
 * activity viewed completes it), and changes still on their way (a page sending its state
 * as it unloads). The position is asked of the cloud once the answer has gone back, so a
 * change takes no longer than without the node. An address in a school's network is one
 * computer: waiting for another person's change behind it costs a moment.
 */
const addresses = new Map<string, Address>();

export interface PendingChange {
  /** Gone through: the cloud's position after it, when it comes. */
  answered(lsn: Promise<string | null>): void;
  /** Did not go through (or its answer did not): nothing to wait for. */
  failed(): void;
}

/** A change from `ip` on its way to the cloud. */
export function changeStarted(ip: string): PendingChange {
  let a = addresses.get(ip);
  if (!a) {
    if (addresses.size > 10_000)
      for (const [k, v] of addresses)
        if (Date.now() - v.since > CHANGE_MEMORY_MS && !v.pending.size) addresses.delete(k);
    addresses.set(ip, (a = { lsn: null, pending: new Set(), since: Date.now() }));
  }
  const at = a;
  at.since = Date.now();
  let settle!: () => void;
  const done = new Promise<void>((ok) => (settle = ok));
  at.pending.add(done);
  void done.then(() => at.pending.delete(done));
  let answered = false;
  return {
    answered(lsn) {
      answered = true;
      at.since = Date.now();
      void lsn.then((v) => {
        if (v && (!at.lsn || lsnValue(v) > lsnValue(at.lsn))) at.lsn = v;
        settle();
      });
    },
    failed() {
      if (!answered) settle();
    },
  };
}

/** The WAL position a read from this address must wait for, or null. */
async function readAfter(req: IncomingMessage, waitMs: number): Promise<string | null> {
  const a = addresses.get(remoteIp(req));
  if (!a || Date.now() - a.since > CHANGE_MEMORY_MS) return null;
  const wait = Math.min(waitMs, a.since + IN_FLIGHT_MS - Date.now());
  if (wait > 0 && a.pending.size)
    await Promise.race([Promise.all([...a.pending]), new Promise((ok) => setTimeout(ok, wait))]);
  return a.lsn;
}

async function handle(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse) {
  const { s } = deps;
  const url = req.url ?? '/';
  const path = url.split('?')[0]!;
  const method = req.method ?? 'GET';
  const mode = deps.mode();
  let route = routeRequest(
    mode,
    method,
    path,
    externalPaths(deps.externalModules),
    !!req.headers['next-action'],
  );
  if (route === 'refuse-offline' || route === 'refuse-sync') return refuse(req, res, route);
  if (route === 'web' && mode === 'ONLINE') {
    // the person's last change, until the replica has it
    const lsn = await readAfter(req, s.lsnWaitMs);
    if (lsn && !(await deps.waitForLsn(lsn, s.lsnWaitMs))) route = 'cloud';
  }
  if (route === 'web') return toWeb(deps, req, res);
  return toCloud(deps, req, res, !isRead(method));
}

function refuse(req: IncomingMessage, res: ServerResponse, route: Route) {
  const reason = route === 'refuse-sync' ? 'sync' : 'offline';
  const wantsPage =
    (req.method === 'GET' || req.method === 'POST') &&
    !req.headers['next-action'] &&
    (req.headers.accept ?? '').includes('text/html');
  req.resume();
  if (wantsPage) {
    // the node's own page says it, in the person's language
    res.writeHead(303, { location: `/unavailable?reason=${reason}` });
    return res.end();
  }
  res.writeHead(503, {
    'content-type': 'application/json',
    'retry-after': '30',
    'x-hubium-node': reason,
  });
  res.end(
    JSON.stringify({
      ok: false,
      code: reason === 'sync' ? 'NODE_SYNC' : 'NODE_OFFLINE',
      message:
        reason === 'sync'
          ? 'The node is passing its work on to the main server; try again in a minute.'
          : 'No connection to the main server: this cannot be done now.',
    }),
  );
}

/** Pipes a request to a target and its answer back, the answer's headers as `respond` makes them. */
/** A connection to the cloud silent this long is taken for a line that went down. */
const CLOUD_IDLE_MS = 120_000;

function pipe(
  req: IncomingMessage,
  res: ServerResponse,
  target: Target,
  headers: http.OutgoingHttpHeaders,
  respond: (up: IncomingMessage) => Promise<http.OutgoingHttpHeaders> | http.OutgoingHttpHeaders,
  onError: (err: unknown) => void,
  idleMs?: number,
): Promise<void> {
  return new Promise((resolve) => {
    const up = target.module.request({ ...target.options, headers, timeout: idleMs }, (answer) => {
      Promise.resolve(respond(answer))
        .then((h) => {
          res.writeHead(answer.statusCode ?? 502, answer.statusMessage, h);
          answer.pipe(res);
          answer.on('end', resolve);
          answer.on('error', () => {
            res.destroy();
            resolve();
          });
        })
        .catch((err) => {
          onError(err);
          answer.resume();
          if (!res.headersSent) res.writeHead(502);
          res.end();
          resolve();
        });
    });
    up.on('timeout', () => up.destroy(new Error('no answer in time')));
    // the person went away (another page, a closed stream): nothing failed upstream
    let gone = false;
    up.on('error', (err) => {
      if (!gone) onError(err);
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('The server is not reachable.');
      } else res.destroy();
      resolve();
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      gone = true;
      up.destroy();
    });
    req.pipe(up);
  });
}

/**
 * Connections to the node's web server, kept open between requests and without the global
 * agent's idle timeout of 5 s: a page waiting for the replica or an event stream stays open.
 */
const webAgent = new http.Agent({ keepAlive: true });

function toWeb(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse) {
  const { s } = deps;
  const headers = copyHeaders(req.headers);
  // the person's address as the gateway takes it (NODE_TRUSTED_PROXY_HOPS): the web server
  // trusts the gateway alone, and its side records name the same address
  headers['x-forwarded-for'] = remoteIp(req);
  headers['x-forwarded-proto'] ??= s.public.app.protocol.replace(':', '');
  headers['x-forwarded-host'] ??= req.headers.host ?? '';
  // the web server polls the agent; this request reads the database of the mode it is in
  headers[NODE_MODE_HEADER] = deps.mode();
  const target: Target = {
    module: http,
    options: {
      agent: webAgent,
      host: s.webUrl.hostname,
      port: Number(s.webUrl.port || 80),
      method: req.method,
      path: req.url,
    },
  };
  return pipe(
    req,
    res,
    target,
    headers,
    (up) => copyHeaders(up.headers),
    (err) => logger.warn({ err }, 'node web server not reachable'),
  );
}

/** The cloud's name for one of the node's: the app and content origins map one to one. */
function cloudHost(s: AgentSettings, host: string | undefined): string {
  if (s.public.content && s.cloud.content && host === s.public.content.host)
    return s.cloud.content.host;
  return s.cloud.app.host;
}

function mapOrigin(s: AgentSettings, value: string | undefined, toCloud: boolean) {
  if (!value) return value;
  const pairs: [URL, URL][] = [[s.public.app, s.cloud.app]];
  if (s.public.content && s.cloud.content) pairs.push([s.public.content, s.cloud.content]);
  for (const [pub, cloud] of pairs) {
    const [from, to] = toCloud ? [pub.origin, cloud.origin] : [cloud.origin, pub.origin];
    if (from !== to && value.startsWith(from)) return to + value.slice(from.length);
  }
  return value;
}

function toCloud(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse, isChange: boolean) {
  const { s } = deps;
  const ip = remoteIp(req);
  const url = req.url ?? '/';
  const target = cloudTarget(s, url, req.method);
  const headers = copyHeaders(req.headers);
  headers.host = cloudHost(s, req.headers.host);
  headers.origin = mapOrigin(s, req.headers.origin, true);
  headers.referer = mapOrigin(s, req.headers.referer, true);
  if (!headers.origin) delete headers.origin;
  if (!headers.referer) delete headers.referer;
  // the cloud trusts the address in the signature, not a forwarded header
  delete headers['x-forwarded-for'];
  headers[NODE_SIGNATURE_HEADER] = signForward(tokenHash(s.node.token), {
    nodeId: s.node.id,
    method: req.method ?? 'GET',
    path: url,
    clientIp: ip,
  });
  const changed = isChange ? changeStarted(ip) : null;
  return pipe(
    req,
    res,
    target,
    headers,
    async (up) => {
      const out = copyHeaders(up.headers);
      if (typeof out.location === 'string') out.location = mapOrigin(s, out.location, false);
      // after a change, the position the replica must reach for the person to see it
      if (isChange && (up.statusCode ?? 500) < 400)
        changed?.answered(
          deps.cloudLsn().catch((err) => {
            logger.debug({ err }, 'no WAL position for the change');
            return null;
          }),
        );
      else changed?.failed();
      return out;
    },
    (err) => deps.cloudUnreachable(err),
    CLOUD_IDLE_MS,
  ).finally(() => changed?.failed());
}
