import {
  type CustomReport,
  type Db,
  Prisma,
  type ReportSchedule,
  SYSTEM_CONTEXT_ID,
} from '@hubium/db';
import { createTranslator } from '@hubium/i18n/packs';
import { log } from '@hubium/log';
import { msg } from '@hubium/module-sdk';
import { csvFile } from '@hubium/module-sdk/csv';
import { fromZonedValue, toZonedValue } from '@hubium/module-sdk/zoned';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { courseFieldLabel, listCourseFields } from '../courses/course-fields.ts';
import { getEnv } from '../env.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { writeXlsx } from '../lib/xlsx.ts';
import { deliverMail, renderActionEmail } from '../mail/mail.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, siteLocale } from '../settings/settings.ts';
import { listProfileFields, profileFieldLabel } from '../users/profile-fields.ts';
import {
  buildQuery,
  type CustomFieldNames,
  checkDefinition,
  LIST_SEPARATOR,
  plainValue,
  type ReportConditionT,
  type ReportDefinitionT,
  reportFieldsOf,
  storedDefinition,
} from './engine.ts';
import { type FieldType, SOURCE_KEYS, SOURCES } from './sources.ts';

const logger = log('reports');

// Custom reports, as Moodle's report builder: those who build reports (report:customise)
// choose a source, columns, conditions and filters, and who else may view the report
// (everyone, holders of roles, members of cohorts, chosen people); the report shows a page
// at a time, downloads as CSV or XLSX, and schedules email it as a file.

type Tx = Prisma.TransactionClient | Db;

export const REPORT_PAGE_SIZE = 50;
/** Downloads and emailed files hold at most this many rows. */
export const REPORT_EXPORT_MAX_ROWS = 100_000;

export const Audiences = z.object({
  all: z.boolean().default(false),
  roleIds: z.array(z.string().uuid()).max(50).default([]),
  cohortIds: z.array(z.string().uuid()).max(50).default([]),
  userIds: z.array(z.string().uuid()).max(500).default([]),
});
export type AudiencesT = z.infer<typeof Audiences>;

/** The custom profile and course fields reports may use. */
export async function customFieldNames(db: Tx): Promise<CustomFieldNames> {
  const [user, course] = await Promise.all([listProfileFields(db), listCourseFields(db)]);
  return { user: user.map((f) => f.shortName), course: course.map((f) => f.shortName) };
}

async function loadReport(db: Tx, id: string) {
  const r = await db.customReport.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Report');
  return r;
}

const definitionOf = (r: CustomReport) => ({
  source: r.source,
  columns: r.columns,
  conditions: r.conditions,
  filters: r.filters,
  sort: r.sort ?? null,
});

// ── building ─────────────────────────────────────────────────────────────────

export const saveReport = defineOperation({
  name: 'report.save',
  offline: 'online',
  input: z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    source: z.enum(SOURCE_KEYS as [string, ...string[]]).optional(),
    columns: z.unknown().optional(),
    conditions: z.unknown().optional(),
    filters: z.unknown().optional(),
    sort: z.unknown().optional(),
    audiences: z.unknown().optional(),
  }),
  authorize: (ctx) => ctx.perm.require('report:customise'),
  async handler(ctx, i) {
    const old = i.id ? await loadReport(ctx.tx, i.id) : null;
    const source = old?.source ?? i.source;
    if (!source) throw new ValidationError({ source: [msg('errors.reports.chooseSource')] });
    const custom = await customFieldNames(ctx.tx);
    let d: ReportDefinitionT;
    try {
      const before = old ? storedDefinition(definitionOf(old), custom) : null;
      d = checkDefinition(
        {
          source,
          columns:
            i.columns ??
            before?.columns ??
            SOURCES[source]!.defaultColumns.map((field) => ({ field })),
          conditions: i.conditions ?? before?.conditions ?? [],
          filters: i.filters ?? before?.filters ?? [],
          sort: i.sort !== undefined ? i.sort : (before?.sort ?? null),
        },
        custom,
      );
    } catch (e) {
      const m = e instanceof z.ZodError ? 'Invalid report' : (e as Error).message;
      throw new ValidationError({ columns: [m] }, m);
    }
    const audiences = Audiences.parse(i.audiences ?? old?.audiences ?? {});
    // roles held across the site (as Moodle's report audiences): a course role would open
    // the whole site's data to anyone teaching some course; the implicit roles (guest,
    // authenticated user) are never assigned at all
    if (audiences.roleIds.length) {
      const held = await ctx.tx.role.findMany({
        where: {
          id: { in: audiences.roleIds },
          isProtected: false,
          assignableLevels: { has: 'SYSTEM' },
        },
        select: { id: true },
      });
      audiences.roleIds = audiences.roleIds.filter((id) => held.some((r) => r.id === id));
    }
    const data = {
      name: i.name,
      columns: d.columns as Prisma.InputJsonValue,
      conditions: d.conditions as Prisma.InputJsonValue,
      filters: d.filters as Prisma.InputJsonValue,
      sort: d.sort ? (d.sort as Prisma.InputJsonValue) : Prisma.DbNull,
      audiences: audiences as Prisma.InputJsonValue,
    };
    if (old) {
      await ctx.tx.customReport.update({ where: { id: old.id }, data });
      return { id: old.id };
    }
    const r = await ctx.tx.customReport.create({
      data: { ...data, source, createdById: ctx.perm.userId },
    });
    await logEvent(ctx.tx, {
      name: 'report.created',
      actorId: ctx.perm.userId,
      objectType: 'customReport',
      objectId: r.id,
      origin: ctx.origin,
    });
    return { id: r.id };
  },
});

export const deleteReport = defineOperation({
  name: 'report.delete',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('report:customise'),
  async handler(ctx, { id }) {
    await loadReport(ctx.tx, id);
    await ctx.tx.customReport.delete({ where: { id } });
    return { id };
  },
});

export const duplicateReport = defineOperation({
  name: 'report.duplicate',
  offline: 'online',
  input: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(255) }),
  authorize: (ctx) => ctx.perm.require('report:customise'),
  async handler(ctx, { id, name }) {
    const r = await loadReport(ctx.tx, id);
    const copy = await ctx.tx.customReport.create({
      data: {
        name,
        source: r.source,
        columns: r.columns as Prisma.InputJsonValue,
        conditions: r.conditions as Prisma.InputJsonValue,
        filters: r.filters as Prisma.InputJsonValue,
        sort: r.sort === null ? Prisma.DbNull : (r.sort as Prisma.InputJsonValue),
        audiences: r.audiences as Prisma.InputJsonValue,
        createdById: ctx.perm.userId,
      },
    });
    return { id: copy.id };
  },
});

// ── who views ────────────────────────────────────────────────────────────────

/**
 * Whether a person is in a report's audience, for any number of reports: their site roles
 * and global groups are read once.
 */
async function audienceOf(db: Tx, userId: string) {
  const [roles, cohorts] = await Promise.all([
    db.roleAssignment.findMany({
      where: { userId, contextId: SYSTEM_CONTEXT_ID },
      select: { roleId: true },
    }),
    db.cohortMember.findMany({ where: { userId }, select: { cohortId: true } }),
  ]);
  const roleIds = new Set(roles.map((r) => r.roleId));
  const cohortIds = new Set(cohorts.map((c) => c.cohortId));
  return (raw: unknown) => {
    const a = Audiences.parse(raw);
    return (
      a.all ||
      a.userIds.includes(userId) ||
      a.roleIds.some((id) => roleIds.has(id)) ||
      a.cohortIds.some((id) => cohortIds.has(id))
    );
  };
}

export async function canViewReport(ctx: RequestContext, r: CustomReport): Promise<boolean> {
  if (await ctx.perm.can('report:customise')) return true;
  if (!ctx.perm.userId) return false;
  return (await audienceOf(ctx.db, ctx.perm.userId))(r.audiences);
}

/** The reports the viewer may see. */
export async function listReports(ctx: RequestContext) {
  const customise = await ctx.perm.can('report:customise');
  const all = await ctx.db.customReport.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { schedules: true } } },
  });
  if (customise) return { customise, reports: all };
  const userId = ctx.perm.userId;
  if (!userId) return { customise, reports: [] };
  const sees = await audienceOf(ctx.db, userId);
  return { customise, reports: all.filter((r) => sees(r.audiences)) };
}

/** Whether there is any report for the viewer (the menu shows Reports then), on every page. */
export async function hasReports(ctx: RequestContext): Promise<boolean> {
  if (await ctx.perm.can('report:customise')) return true;
  const userId = ctx.perm.userId;
  if (!userId) return false;
  const audiences = await ctx.db.customReport.findMany({ select: { audiences: true } });
  if (!audiences.length) return false;
  const sees = await audienceOf(ctx.db, userId);
  return audiences.some((r) => sees(r.audiences));
}

// ── running ──────────────────────────────────────────────────────────────────

export interface ReportColumnView {
  key: string;
  label: string;
  type: FieldType;
}

/** Column labels in a language: the given label, or the field's name (with its aggregation). */
async function labels(db: Tx, d: ReportDefinitionT, locale: string) {
  const t = createTranslator(locale);
  const [profile, course] = await Promise.all([listProfileFields(db), listCourseFields(db)]);
  const fieldLabel = (key: string) => {
    const custom = /^(user|course)\.custom\.(.+)$/.exec(key);
    if (custom) {
      const name = custom[2]!;
      const f =
        custom[1] === 'user'
          ? profile.find((x) => x.shortName === name)
          : course.find((x) => x.shortName === name);
      const what = t(`customReports.entities.${custom[1]}`);
      if (!f) return `${what}: ${name}`;
      return `${what}: ${custom[1] === 'user' ? profileFieldLabel(f as never, locale) : courseFieldLabel(f as never, locale)}`;
    }
    return t(`customReports.fields.${key}`);
  };
  return {
    fieldLabel,
    columns: d.columns.map((c) =>
      c.label
        ? c.label
        : c.aggregate
          ? `${fieldLabel(c.field)} (${t(`customReports.aggregates.${c.aggregate}`)})`
          : fieldLabel(c.field),
    ),
  };
}

export type FilterValues = Record<string, Pick<ReportConditionT, 'op' | 'value'>>;

async function run(
  db: Tx,
  r: CustomReport,
  opts: { filters?: FilterValues; limit?: number; offset?: number; locale: string },
) {
  const custom = await customFieldNames(db);
  const d = storedDefinition(definitionOf(r), custom);
  const tz = (await getAllSettings(db))['site.defaultTimezone'];
  const q = buildQuery(d, custom, {
    tz,
    filters: opts.filters,
    limit: opts.limit,
    offset: opts.offset,
  });
  const [rows, count, names] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>(q.rows),
    db.$queryRaw<{ n: number }[]>(q.count),
    labels(db, d, opts.locale),
  ]);
  return {
    definition: d,
    columns: q.columns.map((c, i) => ({
      key: c.field.key,
      label: names.columns[i]!,
      type: c.type,
    })),
    rows: rows.map((row) => q.columns.map((_, i) => plainValue(row[`c${i}`]))),
    total: count[0]?.n ?? 0,
    fieldLabel: names.fieldLabel,
    tz,
  };
}

/** A page of a report for the viewer, with its filters applied. */
export async function viewReport(
  ctx: RequestContext,
  id: string,
  opts: { filters?: FilterValues; page?: number },
) {
  const r = await loadReport(ctx.db, id);
  if (!(await canViewReport(ctx, r))) throw new ForbiddenError();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const res = await run(ctx.db, r, {
    filters: opts.filters,
    limit: REPORT_PAGE_SIZE,
    offset: (page - 1) * REPORT_PAGE_SIZE,
    locale: ctx.locale,
  });
  const fields = new Map(
    reportFieldsOf(SOURCES[r.source]!, await customFieldNames(ctx.db)).map((f) => [f.key, f]),
  );
  return {
    report: r,
    ...res,
    page,
    pageSize: REPORT_PAGE_SIZE,
    filters: res.definition.filters.map((key) => ({
      key,
      label: res.fieldLabel(key),
      type: fields.get(key)!.type,
      options: fields.get(key)!.options ?? [],
    })),
    customise: await ctx.perm.can('report:customise'),
  };
}

/** A value as text, in a language and the site's time zone. */
export function formatCell(
  v: string | number | boolean | Date | null,
  type: FieldType,
  key: string,
  locale: string,
  tz: string,
  t: (key: string) => string,
): string {
  if (v === null || v === '') return '';
  if (v instanceof Date)
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(v);
  if (typeof v === 'boolean') return t(v ? 'common.yes' : 'common.no');
  if (typeof v === 'number')
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  // one value, or several in a «list» column
  if (type === 'enum')
    return String(v)
      .split(LIST_SEPARATOR)
      .map((x) => t(`customReports.values.${key}.${x}`))
      .join(LIST_SEPARATOR);
  return String(v);
}

/** The whole report (up to the export limit) as a file. */
export async function reportFile(
  db: Tx,
  r: CustomReport,
  format: 'csv' | 'xlsx',
  opts: { filters?: FilterValues; locale: string },
) {
  const res = await run(db, r, { ...opts, limit: REPORT_EXPORT_MAX_ROWS, offset: 0 });
  const t = createTranslator(opts.locale);
  const head = res.columns.map((c) => c.label);
  const body = res.rows.map((row) =>
    row.map((v, i) => {
      const c = res.columns[i]!;
      // numbers stay numbers in spreadsheets
      if (format === 'xlsx' && typeof v === 'number') return v;
      return formatCell(v, c.type, c.key, opts.locale, res.tz, t);
    }),
  );
  const name = `${r.name}`.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'report';
  if (format === 'xlsx')
    return {
      data: Buffer.from(writeXlsx([head, ...body], 'Report')),
      name: `${name}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rows: body.length,
    };
  return {
    data: Buffer.from(csvFile([head, ...body]), 'utf8'),
    name: `${name}.csv`,
    mimeType: 'text/csv; charset=utf-8',
    rows: body.length,
  };
}

export async function exportReport(
  ctx: RequestContext,
  id: string,
  format: 'csv' | 'xlsx',
  filters?: FilterValues,
) {
  const r = await loadReport(ctx.db, id);
  if (!(await canViewReport(ctx, r))) throw new ForbiddenError();
  return reportFile(ctx.db, r, format, { filters, locale: ctx.locale });
}

// ── schedules ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** When a schedule runs next after `after`, at its hour in the site's time zone. */
export function nextRunAt(
  s: Pick<ReportSchedule, 'frequency' | 'hour' | 'day'>,
  tz: string,
  after: Date,
): Date {
  // calendar days of the zone, from the day `after` falls on: adding 24 hours would skip a
  // day of 23 hours (the clocks going forward) late in the evening
  const [y0, m0, d0] = toZonedValue(after.toISOString(), tz)
    .slice(0, 10)
    .split('-')
    .map(Number) as [number, number, number];
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(y0, m0 - 1, d0 + i));
    const wall = day.toISOString().slice(0, 10);
    const d = day.getUTCDate();
    const weekday = day.getUTCDay() || 7;
    const fits =
      s.frequency === 'DAILY' ||
      (s.frequency === 'WEEKDAYS' && weekday <= 5) ||
      (s.frequency === 'WEEKLY' && weekday === s.day) ||
      (s.frequency === 'MONTHLY' && d === s.day);
    if (!fits) continue;
    const at = new Date(fromZonedValue(`${wall}T${pad(s.hour)}:00`, tz));
    if (at > after) return at;
  }
  return new Date(after.getTime() + 86_400_000);
}

export const ScheduleInput = z.object({
  id: z.string().uuid().optional(),
  reportId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  format: z.enum(['csv', 'xlsx']).default('xlsx'),
  frequency: z.enum(['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY']).default('WEEKLY'),
  hour: z.coerce.number().int().min(0).max(23).default(8),
  day: z.coerce.number().int().min(1).max(28).default(1),
  toAudience: z.boolean().default(false),
  userIds: z.array(z.string().uuid()).max(200).default([]),
  skipEmpty: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

export const saveSchedule = defineOperation({
  name: 'report.schedule.save',
  offline: 'online',
  input: ScheduleInput,
  authorize: (ctx) => ctx.perm.require('report:customise'),
  async handler(ctx, i) {
    const r = await loadReport(ctx.tx, i.reportId);
    if (i.frequency === 'WEEKLY' && i.day > 7)
      throw new ValidationError({ day: [msg('errors.reports.weekday')] });
    if (!i.toAudience && !i.userIds.length)
      throw new ValidationError({ userIds: [msg('errors.reports.chooseRecipients')] });
    const tz = (await getAllSettings(ctx.tx))['site.defaultTimezone'];
    const data = {
      name: i.name,
      format: i.format,
      frequency: i.frequency,
      hour: i.hour,
      day: i.day,
      toAudience: i.toAudience,
      userIds: i.userIds,
      skipEmpty: i.skipEmpty,
      enabled: i.enabled,
      nextRunAt: nextRunAt(i, tz, ctx.now),
    };
    if (i.id) {
      const s = await ctx.tx.reportSchedule.findFirst({ where: { id: i.id, reportId: r.id } });
      if (!s) throw new NotFoundError('Schedule');
      await ctx.tx.reportSchedule.update({ where: { id: s.id }, data });
      return { id: s.id };
    }
    const s = await ctx.tx.reportSchedule.create({
      data: { ...data, reportId: r.id, createdById: ctx.perm.userId },
    });
    return { id: s.id };
  },
});

export const deleteSchedule = defineOperation({
  name: 'report.schedule.delete',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('report:customise'),
  async handler(ctx, { id }) {
    await ctx.tx.reportSchedule.delete({ where: { id } });
    return { id };
  },
});

/** Who a schedule sends to: its people, and the report's audience if it says so (not "everyone"). */
async function recipients(db: Tx, s: ReportSchedule, r: CustomReport) {
  const a = Audiences.parse(r.audiences);
  const ids = new Set(s.userIds);
  if (s.toAudience) {
    for (const u of a.userIds) ids.add(u);
    if (a.roleIds.length)
      for (const x of await db.roleAssignment.findMany({
        where: { roleId: { in: a.roleIds }, contextId: SYSTEM_CONTEXT_ID },
        select: { userId: true },
        distinct: ['userId'],
      }))
        ids.add(x.userId);
    if (a.cohortIds.length)
      for (const x of await db.cohortMember.findMany({
        where: { cohortId: { in: a.cohortIds } },
        select: { userId: true },
      }))
        ids.add(x.userId);
  }
  return db.user.findMany({
    where: { id: { in: [...ids] }, status: 'ACTIVE', deletedAt: null, emailPlaceholder: false },
    select: { id: true, email: true, locale: true },
  });
}

/** Sends a schedule's report now; the number of letters sent. With `due`, only when the
 *  schedule is due (the cron): another worker may have sent it already. */
export async function sendSchedule(
  db: Db,
  id: string,
  now = new Date(),
  { due = false } = {},
): Promise<number> {
  const s = await db.reportSchedule.findUnique({ where: { id }, include: { report: true } });
  if (!s) return 0;
  const settings = await getAllSettings(db);
  const tz = settings['site.defaultTimezone'];
  // The schedule moves to its next time before anything is sent: a letter that fails is not
  // sent again to everyone at the next run, and of two workers only one sends it.
  const claimed = await db.reportSchedule.updateMany({
    where: { id: s.id, nextRunAt: due ? { lte: now } : s.nextRunAt },
    data: { lastRunAt: now, nextRunAt: nextRunAt(s, tz, now) },
  });
  if (!claimed.count) return 0;
  const people = await recipients(db, s, s.report);
  // one file per language the recipients read
  const files = new Map<string, Awaited<ReturnType<typeof reportFile>>>();
  let sent = 0;
  let rows: number | null = null;
  for (const p of people) {
    const locale = p.locale ?? siteLocale(settings);
    let file = files.get(locale);
    if (!file) {
      file = await reportFile(db, s.report, s.format === 'csv' ? 'csv' : 'xlsx', { locale });
      files.set(locale, file);
    }
    rows = file.rows;
    if (s.skipEmpty && !file.rows) continue;
    const t = createTranslator(locale);
    const url = `${getEnv().APP_URL.replace(/\/+$/, '')}/reports/${s.reportId}`;
    const { html, text } = renderActionEmail({
      locale,
      siteName: settings['site.name'],
      heading: s.report.name,
      intro: t('customReports.email.intro', { name: s.report.name, rows: file.rows }),
      action: { label: t('customReports.email.open'), url },
      footer: t('customReports.email.footer', { schedule: s.name }),
    });
    try {
      await deliverMail({
        to: p.email,
        subject: t('customReports.email.subject', {
          name: s.report.name,
          site: settings['site.name'],
        }),
        html,
        text,
        attachments: [{ filename: file.name, content: file.data, contentType: file.mimeType }],
      });
      sent++;
    } catch (err) {
      // one address the mail server refuses does not keep the report from the others
      logger.warn({ err, scheduleId: s.id, userId: p.id }, 'Report email not sent');
    }
  }
  await db.reportSchedule.update({
    where: { id: s.id },
    data: { lastRows: sent ? rows : null },
  });
  return sent;
}

/** Sends a schedule's report now, as the schedule would; the number of letters sent. */
export const sendScheduleNow = defineOperation({
  name: 'report.schedule.send',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('report:customise'),
  // the letters go out one by one, each schedule claimed before them
  mutation: false,
  handler: (ctx, { id }) => sendSchedule(ctx.db, id, ctx.now),
});

/** Cron (every 15 minutes): the schedules that are due. */
export async function runDueSchedules(db: Db, now = new Date()): Promise<number> {
  const due = await db.reportSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: { id: true },
  });
  let n = 0;
  for (const s of due) {
    try {
      n += await sendSchedule(db, s.id, now, { due: true });
    } catch (err) {
      // a report that cannot be built is tried again at its next time, and the others go out
      logger.error({ err, scheduleId: s.id }, 'Report schedule failed');
    }
  }
  return n;
}

/** A report as its editor shows it. */
export async function reportForEdit(ctx: RequestContext, id: string) {
  await ctx.perm.require('report:customise');
  const r = await ctx.db.customReport.findUnique({
    where: { id },
    include: { schedules: { orderBy: { createdAt: 'asc' } } },
  });
  if (!r) throw new NotFoundError('Report');
  const custom = await customFieldNames(ctx.db);
  const fields = reportFieldsOf(SOURCES[r.source]!, custom);
  const definition = storedDefinition(definitionOf(r), custom);
  const names = await labels(ctx.db, definition, ctx.locale);
  return {
    report: r,
    definition,
    audiences: Audiences.parse(r.audiences),
    fields: fields.map((f) => ({
      key: f.key,
      type: f.type,
      label: names.fieldLabel(f.key),
      options: f.options ?? [],
    })),
  };
}
