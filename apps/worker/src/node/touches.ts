import { log } from '@hubium/log';
import { cloudCall } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// Side records of page views (last visits, activities viewed) from the node's web server,
// sent to the cloud in batches while connected; kept until then (at most MAX, the oldest
// go first: they are the least worth keeping).

const logger = log('node-agent');
const MAX = 20_000;
const BATCH = 500;

export class TouchQueue {
  private items: unknown[] = [];
  private sending = false;

  constructor(private readonly s: AgentSettings) {}

  add(item: unknown): void {
    this.items.push(item);
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
  }

  async flush(): Promise<void> {
    if (this.sending || !this.items.length) return;
    this.sending = true;
    try {
      while (this.items.length) {
        const batch = this.items.slice(0, BATCH);
        await cloudCall(this.s, 'POST', 'touch', batch);
        this.items.splice(0, batch.length);
      }
    } catch (err) {
      logger.debug({ err, waiting: this.items.length }, 'side records not sent yet');
    } finally {
      this.sending = false;
    }
  }
}
