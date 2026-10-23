import net from 'node:net';
import { fileURLToPath } from 'node:url';

// The internet between a local node and the cloud, for the node scenarios: TCP links the
// scenarios cut and restore. A cut link holds what it has (connections stall as they do
// when a line goes down) or, with `refuse`, resets them; new connections get the same.
// `lose-replay` loses the answer to the next batch of a sync: the cloud takes the batch and
// the line goes down before the node hears back.
//
//   node e2e/node/link.ts 4100=127.0.0.1:3000 4101=127.0.0.1:55432 --control 4199
//   curl -X POST localhost:4199/down   (or /up, /refuse, /lose-replay; GET / tells the state)

export type LinkState = 'up' | 'down' | 'refuse';

export class Link {
  state: LinkState = 'up';
  /** The answer to the next sync batch is to be lost; how many were. */
  loseReplay = false;
  lostReplays = 0;
  private readonly servers: net.Server[] = [];
  /** Each client with its upstream connection. */
  private readonly open = new Map<net.Socket, net.Socket>();
  private readonly held = new Set<net.Socket>();

  private readonly routes: { listen: number; host: string; port: number }[];

  constructor(routes: { listen: number; host: string; port: number }[]) {
    this.routes = routes;
  }

  async start(): Promise<void> {
    for (const r of this.routes) {
      const server = net.createServer((client) => this.accept(client, r));
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(r.listen, '0.0.0.0', () => ok());
      });
      this.servers.push(server);
    }
  }

  private accept(client: net.Socket, r: { host: string; port: number }): void {
    client.on('error', () => {});
    if (this.state === 'refuse') return void client.resetAndDestroy();
    if (this.state === 'down') {
      // nothing comes through: the connection waits until it times out
      this.held.add(client);
      client.on('close', () => this.held.delete(client));
      return;
    }
    const upstream = net.connect(r.port, r.host);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    this.open.set(client, upstream);
    client.on('close', () => this.open.delete(client));
    client.pipe(upstream).pipe(client);
    client.on('data', (chunk: Buffer) => {
      if (!this.loseReplay || !chunk.includes('POST /api/node/replay')) return;
      this.loseReplay = false;
      // the cloud answers once it has done the batch: the answer goes nowhere
      upstream.unpipe(client);
      upstream.once('data', () => {
        this.lostReplays++;
        client.resetAndDestroy();
        upstream.destroy();
      });
      // unpiped, it stays paused until told
      upstream.resume();
    });
  }

  /** Cuts the link: open connections stall (`down`) or are reset (`refuse`). */
  cut(how: 'down' | 'refuse' = 'down'): void {
    this.state = how;
    for (const [client, upstream] of this.open) {
      if (how === 'refuse') {
        client.resetAndDestroy();
        upstream.resetAndDestroy();
        continue;
      }
      // stalled: no more bytes either way
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.pause();
      upstream.pause();
      this.held.add(client);
      this.held.add(upstream);
    }
    this.open.clear();
  }

  /** Restores it: stalled connections are dropped, as a line that comes back drops them. */
  restore(): void {
    this.state = 'up';
    for (const s of this.held) s.destroy();
    this.held.clear();
  }

  async stop(): Promise<void> {
    this.restore();
    for (const [client, upstream] of this.open) {
      client.destroy();
      upstream.destroy();
    }
    await Promise.all(this.servers.map((s) => new Promise((ok) => s.close(ok))));
  }
}

/** Parses `listen=host:port` arguments. */
export function parseRoutes(args: string[]) {
  return args.map((a) => {
    const m = /^(\d+)=([^:]+):(\d+)$/.exec(a);
    if (!m) throw new Error(`Not a route: ${a} (listen=host:port)`);
    return { listen: Number(m[1]), host: m[2]!, port: Number(m[3]) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--control');
  const control = i >= 0 ? Number(args.splice(i, 2)[1]) : 0;
  const link = new Link(parseRoutes(args));
  await link.start();
  if (control) {
    const { createServer } = await import('node:http');
    createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/down') link.cut('down');
      else if (req.method === 'POST' && req.url === '/refuse') link.cut('refuse');
      else if (req.method === 'POST' && req.url === '/up') link.restore();
      else if (req.method === 'POST' && req.url === '/lose-replay') link.loseReplay = true;
      res.end(`${link.state} lost-replays=${link.lostReplays}\n`);
    }).listen(control, '127.0.0.1');
  }
  console.log(`link up: ${args.join(' ')}${control ? `, control on ${control}` : ''}`);
}
