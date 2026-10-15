import {
  BULK_USERS_JOB,
  type BulkAction,
  COMPLETION_RECOMPUTE_JOB,
  CORE_SCHEDULE,
  COURSE_PROGRESS_JOB,
  deliverWebhook,
  expireEnrolments,
  INDEX_COURSE_JOB,
  INDEX_JOB,
  indexActivity,
  indexCourse,
  LDAP_SYNC_JOB,
  PUSH_JOB,
  pruneWebhookDeliveries,
  QUIZGEN_JOB,
  recomputeActivityForAll,
  recomputeCourseForAll,
  recordHeartbeat,
  runBulkUsersJob,
  runQuizGeneration,
  sendPushNotifications,
  syncLdapUsers,
  WEBHOOK_JOB,
} from '@hubium/core';
import { publishDueAnnouncements } from '@hubium/core/announcements/announcements';
import { BADGES_REVIEW_JOB, reviewAllBadges, reviewBadge } from '@hubium/core/badges/badges';
import { sendCalendarReminders } from '@hubium/core/calendar/calendar';
import { syncDueSubscriptions } from '@hubium/core/calendar/subscriptions';
import { CERTIFICATES_REVIEW_JOB, reviewCertificate } from '@hubium/core/certificates/certificates';
import { syncTemplateCohorts } from '@hubium/core/competencies/plans';
import { purgeRecycleBin } from '@hubium/core/courses/recyclebin';
import { pruneEventLog } from '@hubium/core/events/prune';
import { garbageCollectBlobs, reconcileBlobObjects } from '@hubium/core/files/files';
import { cleanupUploads } from '@hubium/core/files/uploads';
import { GRADES_RECALC_JOB, recalcCourseTotals } from '@hubium/core/grades/gradebook';
import { deliverMail } from '@hubium/core/mail/mail';
import {
  deliverNotifications,
  type NotifyInput,
  pruneNotifications,
  sendDigests,
  sendNotificationEmails,
} from '@hubium/core/notifications/notifications';
import { runDueSchedules } from '@hubium/core/reports/reports';
import type { Db } from '@hubium/db';
import {
  BACKUP_JOB,
  failLostTasks,
  IMPORT_JOB,
  runBackupTask,
  runImportTask,
} from '@hubium/interchange';

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
    // Proves to Admin → Environment and /api/metrics that scheduled jobs run.
    name: 'system.heartbeat',
    cron: CORE_SCHEDULE['system.heartbeat'],
    async handler(_data: never, { db }) {
      return recordHeartbeat(db);
    },
  },
  {
    name: PUSH_JOB,
    batchSize: 5,
    async handler(data: { ids: string[] }, { db }) {
      return sendPushNotifications(db, data.ids);
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
    cron: CORE_SCHEDULE['email.digest'],
    async handler(_data: never, { db }) {
      return { sent: await sendDigests(db) };
    },
  },
  {
    name: 'announcements.publish',
    cron: CORE_SCHEDULE['announcements.publish'],
    async handler(_data: never, { db }) {
      return { published: await publishDueAnnouncements(db) };
    },
  },
  {
    name: 'calendar.reminders',
    cron: CORE_SCHEDULE['calendar.reminders'],
    async handler(_data: never, { db }) {
      return { notified: await sendCalendarReminders(db) };
    },
  },
  {
    // hourly for every active badge; with a badge id when one is activated
    name: BADGES_REVIEW_JOB,
    cron: CORE_SCHEDULE['badges.review'],
    async handler(data: { badgeId?: string } | null, { db }) {
      return {
        awarded: data?.badgeId ? await reviewBadge(db, data.badgeId) : await reviewAllBadges(db),
      };
    },
  },
  {
    // when a certificate is switched on: those who have completed the course already
    name: CERTIFICATES_REVIEW_JOB,
    async handler(data: { certificateId: string }, { db }) {
      return { issued: await reviewCertificate(db, data.certificateId) };
    },
  },
  {
    name: 'competency.plans.sync',
    cron: CORE_SCHEDULE['competency.plans.sync'],
    async handler(_data: never, { db }) {
      return { created: await syncTemplateCohorts(db) };
    },
  },
  {
    name: 'reports.schedules',
    cron: CORE_SCHEDULE['reports.schedules'],
    async handler(_data: never, { db }) {
      return { sent: await runDueSchedules(db) };
    },
  },
  {
    name: 'calendar.subscriptions',
    cron: CORE_SCHEDULE['calendar.subscriptions'],
    async handler(_data: never, { db }) {
      return { refreshed: await syncDueSubscriptions(db) };
    },
  },
  {
    name: COMPLETION_RECOMPUTE_JOB,
    async handler(data: { activityId: string }, { db }) {
      return { users: await recomputeActivityForAll(db, data.activityId) };
    },
  },
  {
    name: GRADES_RECALC_JOB,
    async handler(data: { courseId: string }, { db }) {
      return { users: await recalcCourseTotals(db, data.courseId) };
    },
  },
  {
    name: COURSE_PROGRESS_JOB,
    async handler(data: { courseId: string }, { db }) {
      return { users: await recomputeCourseForAll(db, data.courseId) };
    },
  },
  {
    // Access already ends with endsAt; this keeps statuses and reports in step.
    name: 'enrol.expire',
    cron: CORE_SCHEDULE['enrol.expire'],
    async handler(_data: never, { db }) {
      return { expired: await expireEnrolments(db) };
    },
  },
  {
    name: 'notifications.prune',
    cron: CORE_SCHEDULE['notifications.prune'],
    async handler(_data: never, { db }) {
      return { deleted: await pruneNotifications(db) };
    },
  },
  {
    name: 'eventlog.prune',
    cron: CORE_SCHEDULE['eventlog.prune'],
    async handler(_data: never, { db }) {
      return { deleted: await pruneEventLog(db) };
    },
  },
  {
    name: INDEX_JOB,
    // Course copies and restores queue an index job per activity; take them ten at a time
    // instead of one per polling interval.
    batchSize: 10,
    async handler(data: { activityId: string }, { db }) {
      return indexActivity(db, data.activityId);
    },
  },
  {
    name: INDEX_COURSE_JOB,
    async handler(data: { courseId: string }, { db }) {
      return indexCourse(db, data.courseId);
    },
  },
  {
    name: QUIZGEN_JOB,
    async handler(data: { generationId: string }, { db }) {
      const r = await runQuizGeneration(db, data.generationId);
      return { ok: r !== null };
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
    name: BACKUP_JOB,
    async handler(data: { taskId: string }, { db }) {
      return { fileId: await runBackupTask(db, data.taskId) };
    },
  },
  {
    name: 'interchange.lost',
    cron: CORE_SCHEDULE['interchange.lost'],
    async handler(_data: never, { db }) {
      return failLostTasks(db);
    },
  },
  {
    // One at a time: a slow receiver must not hold back a batch of other deliveries.
    name: WEBHOOK_JOB,
    async handler(data: { deliveryId: string }, { db }) {
      return deliverWebhook(db, data.deliveryId);
    },
  },
  {
    name: 'webhooks.prune',
    cron: CORE_SCHEDULE['webhooks.prune'],
    async handler(_data: never, { db }) {
      return { deleted: await pruneWebhookDeliveries(db) };
    },
  },
  {
    name: 'recyclebin.purge',
    cron: CORE_SCHEDULE['recyclebin.purge'],
    async handler(_data: never, { db }) {
      return purgeRecycleBin(db);
    },
  },
  {
    name: 'files.gc',
    cron: CORE_SCHEDULE['files.gc'],
    async handler(_data: never, { db }) {
      return {
        deleted: await garbageCollectBlobs(db),
        objects: await reconcileBlobObjects(db),
        uploads: await cleanupUploads(db),
      };
    },
  },
  {
    name: BULK_USERS_JOB,
    async handler(data: { actorId: string; ids: string[]; action: BulkAction }, { db }) {
      return runBulkUsersJob(db, data);
    },
  },
  {
    // directory accounts follow the directory (does nothing while LDAP is off)
    name: LDAP_SYNC_JOB,
    cron: CORE_SCHEDULE[LDAP_SYNC_JOB],
    async handler(_data: never, { db }) {
      return syncLdapUsers(db);
    },
  },
  {
    name: 'auth.sessions.cleanup',
    cron: CORE_SCHEDULE['auth.sessions.cleanup'],
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
