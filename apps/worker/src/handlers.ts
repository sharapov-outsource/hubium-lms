import { publishDueAnnouncements } from '@hubium/core/announcements/announcements';
import { sendCalendarReminders } from '@hubium/core/calendar/calendar';
import { garbageCollectBlobs } from '@hubium/core/files/files';
import { cleanupUploads } from '@hubium/core/files/uploads';
import { deliverMail } from '@hubium/core/mail/mail';
import {
  deliverNotifications,
  type NotifyInput,
  pruneNotifications,
  sendDigests,
  sendNotificationEmails,
} from '@hubium/core/notifications/notifications';
import type { Db } from '@hubium/db';
import { IMPORT_JOB, runImportTask } from '@hubium/interchange';

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
    name: 'notification.email',
    batchSize: 5,
    async handler(data: { ids: string[] }, { db }) {
      return { sent: await sendNotificationEmails(db, data.ids) };
    },
  },
  {
    // One chunk of a large audience (see notifyUsers).
    name: 'notification.fanout',
    async handler(data: { userIds: string[]; n: NotifyInput }, { db }) {
      const created = await db.$transaction(
        (tx) => deliverNotifications(tx, data.userIds, data.n),
        {
          timeout: 120_000,
        },
      );
      return { created };
    },
  },
  {
    // Users get their digest at their own local hour; the job runs every hour.
    name: 'email.digest',
    cron: '0 * * * *',
    async handler(_data: never, { db }) {
      return { sent: await sendDigests(db) };
    },
  },
  {
    name: 'announcements.publish',
    cron: '* * * * *',
    async handler(_data: never, { db }) {
      return { published: await publishDueAnnouncements(db) };
    },
  },
  {
    name: 'calendar.reminders',
    cron: '10 * * * *',
    async handler(_data: never, { db }) {
      return { notified: await sendCalendarReminders(db) };
    },
  },
  {
    name: 'notifications.prune',
    cron: '41 4 * * *',
    async handler(_data: never, { db }) {
      return { deleted: await pruneNotifications(db) };
    },
  },
  {
    name: IMPORT_JOB,
    async handler(data: { taskId: string }, { db }) {
      const report = await runImportTask(db, data.taskId);
      return { ok: report !== null };
    },
  },
  {
    name: 'files.gc',
    cron: '17 3 * * *',
    async handler(_data: never, { db }) {
      return { deleted: await garbageCollectBlobs(db), uploads: await cleanupUploads(db) };
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
