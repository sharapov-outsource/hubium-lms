import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (
  body: Record<string, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

/** Minimal HTTP server standing in for a provider API. */
export async function fakeServer(handler: Handler) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ ...body, $path: req.url, $headers: req.headers });
    handler(body, req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const sse = (res: ServerResponse, events: [string | null, unknown][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events)
    res.write(
      `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    );
  res.end();
};
