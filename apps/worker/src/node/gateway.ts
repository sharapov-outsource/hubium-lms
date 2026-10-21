import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { clientIp } from '@hubium/core/client-ip';
import { NODE_SIGNATURE_HEADER, signForward, tokenHash } from '@hubium/core/node/auth';
import { NODE_MODE_HEADER, type NodeMode } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import { cloudTarget, type Target } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The node's gateway: everything the people of its network ask goes through it (behind the
// node's Caddy). While the node is connected, reading requests are answered by the node's
// web server from its replica, and changes go to the cloud, signed by the node; the cloud's
// answer to a change carries the WAL position after it, and a reading request with that
// position waits until the replica has it (or goes to the cloud), so people see their own
// changes. Without a connection everything is answered on the node.

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

export const LSN_COOKIE = 'hubium_lsn';

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

/** The WAL position in the request's cookie: the person's last change through the node. */
export function lsnFromCookie(cookie: string | undefined): string | null {
  const m = new RegExp(
    `(?:^|;\\s*)${LSN_COOKIE}=([0-9A-F]+%2F[0-9A-F]+|[0-9A-F]+/[0-9A-F]+)`,
    'i',
  ).exec(cookie ?? '');
  return m ? decodeURIComponent(m[1]!) : null;
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
    const lsn = lsnFromCookie(req.headers.cookie);
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
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
    .filter(Boolean)
    .join(', ');
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
  return pipe(
    req,
    res,
    target,
    headers,
    async (up) => {
      const out = copyHeaders(up.headers);
      if (typeof out.location === 'string') out.location = mapOrigin(s, out.location, false);
      // after a change, the position the replica must reach for the person to see it
      if (isChange && (up.statusCode ?? 500) < 400) {
        try {
          const lsn = await deps.cloudLsn();
          const cookies = ([] as string[]).concat((out['set-cookie'] as string[]) ?? []);
          cookies.push(
            `${LSN_COOKIE}=${encodeURIComponent(lsn)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`,
          );
          out['set-cookie'] = cookies;
        } catch (err) {
          logger.debug({ err }, 'no WAL position for the change');
        }
      }
      return out;
    },
    (err) => deps.cloudUnreachable(err),
    CLOUD_IDLE_MS,
  );
}
