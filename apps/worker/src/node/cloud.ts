import { createReadStream } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { nodeAuthorization } from '@hubium/core/node/auth';
import type { AgentSettings } from './settings.ts';

// Requests to the cloud. The cloud is reached under its own name (Host, TLS server name),
// at NODE_HUB_ADDRESS when the network sends that name to the node itself.

export interface Target {
  module: typeof http | typeof https;
  options: http.RequestOptions & { servername?: string };
}

/** Where a request to the cloud's `path` goes: its connection and its Host. */
export function cloudTarget(s: AgentSettings, path: string, method = 'GET'): Target {
  const hub = new URL(s.node.hubUrl);
  const secure = hub.protocol === 'https:';
  const [host, port] = (s.node.hubAddress ?? hub.host).split(':');
  return {
    module: secure ? https : http,
    options: {
      host,
      port: Number(port || hub.port || (secure ? 443 : 80)),
      servername: hub.hostname,
      method,
      path,
      headers: { host: hub.host },
    },
  };
}

export class CloudError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

/** A call of the node API, with the node's token; JSON in, JSON out. */
export function cloudCall<T>(
  s: AgentSettings,
  method: string,
  what: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  const t = cloudTarget(s, `/api/node/${what}`, method);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<T>((resolve, reject) => {
    const req = t.module.request({
      ...t.options,
      headers: {
        ...t.options.headers,
        authorization: nodeAuthorization(s.node.id, s.node.token),
        accept: 'application/json',
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {}),
      },
      timeout: timeoutMs,
    });
    req.on('timeout', () => req.destroy(new Error(`the cloud did not answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) {
          let message = text;
          try {
            message = (JSON.parse(text) as { error?: string }).error ?? text;
          } catch {
            // not JSON
          }
          return reject(new CloudError(res.statusCode ?? 500, message));
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.end(payload);
  });
}

/** A streaming call of the node API (the bus, a file): the response as it comes. */
export function cloudStream(
  s: AgentSettings,
  what: string,
  signal: AbortSignal,
  connectTimeoutMs = 10_000,
): Promise<IncomingMessage> {
  const t = cloudTarget(s, `/api/node/${what}`);
  return new Promise((resolve, reject) => {
    const req = t.module.request({
      ...t.options,
      headers: {
        ...t.options.headers,
        authorization: nodeAuthorization(s.node.id, s.node.token),
      },
      signal,
    });
    const timer = setTimeout(
      () => req.destroy(new Error('the cloud did not answer')),
      connectTimeoutMs,
    );
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        return reject(
          new CloudError(res.statusCode ?? 500, `the cloud answered ${res.statusCode}`),
        );
      }
      resolve(res);
    });
    req.end();
  });
}

/** Sends a file of the node's disk to the cloud's storage under the same key. */
export function cloudUpload(
  s: AgentSettings,
  key: string,
  file: { path: string; size: number },
): Promise<void> {
  const t = cloudTarget(s, `/api/node/files/put?key=${encodeURIComponent(key)}`, 'PUT');
  return new Promise((resolve, reject) => {
    const req = t.module.request({
      ...t.options,
      headers: {
        ...t.options.headers,
        authorization: nodeAuthorization(s.node.id, s.node.token),
        'content-type': 'application/octet-stream',
        'content-length': file.size,
      },
      timeout: 30 * 60_000,
    });
    req.on('timeout', () => req.destroy(new Error('the cloud did not take the file in time')));
    req.on('error', reject);
    req.on('response', (res) => {
      res.resume();
      res.on('end', () =>
        (res.statusCode ?? 500) < 400
          ? resolve()
          : reject(new CloudError(res.statusCode ?? 500, `the cloud refused ${key}`)),
      );
    });
    createReadStream(file.path).on('error', reject).pipe(req);
  });
}
