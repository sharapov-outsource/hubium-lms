import { garbageCollectBlobs } from '@hubium/core/files/files';
import { deliverMail } from '@hubium/core/mail/mail';
import type { Db } from '@hubium/db';

export interface JobHandlerDef {
  name: string;
  /** Cron (UTC) when this job should also be scheduled. */
  cron?: string;
  queue?: 'default' | 'media';
  batchSize?: number;
  handler: (data: never, ctx: { db: Db; jobId: string }) => Promise<unknown>;
}

export const coreHandlers: JobHandlerDef[] = [
  {
    name: 'email.send',
    batchSize: 5,
    async handler(data: { to: string; subject: string; html: string; text: string }) {
      if (data.to.endsWith('.invalid')) return { skipped: 'placeholder address' };
      const info = await deliverMail(data);
      return { messageId: info.messageId };
    },
  },
  {
    name: 'files.gc',
    cron: '17 3 * * *',
    async handler(_data: never, { db }) {
      return { deleted: await garbageCollectBlobs(db) };
    },
  },
  {
    name: 'auth.sessions.cleanup',
    cron: '23 * * * *',
    async handler(_data: never, { db }) {
      const now = new Date();
      const [s, v] = await Promise.all([
        db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        db.verification.deleteMany({ where: { expiresAt: { lt: now } } }),
      ]);
      return { sessions: s.count, verifications: v.count };
    },
  },
];
