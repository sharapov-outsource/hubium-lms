import { log } from '@hubium/log';
import { cloudCall } from './cloud.ts';
import { changeStarted, type PendingChange } from './gateway.ts';
import type { AgentSettings } from './settings.ts';

// Side records of page views (last visits, activities viewed) from the node's web server,
// sent to the cloud as they come while connected, in batches; kept until then (at most MAX,
// the oldest go first: they are the least worth keeping). A record names the person's
// address: their next reads wait for it (an activity viewed completes it, and the course
// page that follows shows that).

const logger = log('node-agent');
const MAX = 20_000;
const BATCH = 500;

interface Item {
  record: unknown;
  waiting: PendingChange | null;
}

export class TouchQueue {
  private items: Item[] = [];
  private sending = false;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly s: AgentSettings,
    private readonly online: () => boolean,
  ) {}

  add(raw: unknown): void {
    const { ip, ...record } = (raw ?? {}) as { ip?: unknown };
    const online = this.online();
    this.items.push({
      record,
      waiting: online && typeof ip === 'string' && ip ? changeStarted(ip) : null,
    });
    if (this.items.length > MAX)
      for (const gone of this.items.splice(0, this.items.length - MAX)) gone.waiting?.failed();
    if (online) this.soon ??= setTimeout(() => void this.flush(), 20);
  }

  async flush(): Promise<void> {
    this.soon = null;
    if (this.sending || !this.items.length) return;
    this.sending = true;
    try {
      while (this.items.length) {
        const batch = this.items.slice(0, BATCH);
        const r = await cloudCall<{ lsn?: string }>(
          this.s,
          'POST',
          'touch',
          batch.map((i) => i.record),
        );
        this.items.splice(0, batch.length);
        for (const i of batch) i.waiting?.answered(Promise.resolve(r.lsn ?? null));
      }
    } catch (err) {
      logger.debug({ err, waiting: this.items.length }, 'side records not sent yet');
      // the people behind them read on; the records go later
      for (const i of this.items) {
        i.waiting?.failed();
        i.waiting = null;
      }
    } finally {
      this.sending = false;
    }
  }
}
