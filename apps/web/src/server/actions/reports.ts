'use server';

import {
  deleteReport,
  deleteSchedule,
  duplicateReport,
  saveReport,
  saveSchedule,
  sendSchedule,
  ValidationError,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { getContext } from '../session';

const json = (v: string | undefined, field: string) => {
  try {
    return v ? JSON.parse(v) : undefined;
  } catch {
    throw new ValidationError({ [field]: ['Invalid'] });
  }
};

/** People named by email or login, one per line or separated by commas. */
async function usersByLogin(text: string | undefined, field: string) {
  const logins = (text ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!logins.length) return [];
  const users = await db.user.findMany({
    where: { OR: [{ email: { in: logins } }, { username: { in: logins } }], deletedAt: null },
    select: { id: true, email: true, username: true },
  });
  const unknown = logins.filter(
    (l) => !users.some((u) => u.email.toLowerCase() === l || u.username?.toLowerCase() === l),
  );
  if (unknown.length) throw new ValidationError({ [field]: [`Not found: ${unknown.join(', ')}`] });
  return users.map((u) => u.id);
}

export async function createReportAction(fd: FormData) {
  const r = await runAction(async () => {
    const v = formToObject(fd);
    return saveReport.run(await getContext(), { name: v.name ?? '', source: v.source });
  });
  if (r.ok) redirect(`/reports/${r.data.id}/edit`);
  return r;
}

/** The editor's columns, conditions, filters and order. */
export async function saveReportAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveReport.run(await getContext(), {
      id: v.id,
      name: v.name ?? '',
      columns: json(v.columns, 'columns'),
      conditions: json(v.conditions, 'columns'),
      filters: json(v.filters, 'columns'),
      sort: json(v.sort, 'columns') ?? null,
    });
    revalidatePath(`/reports/${v.id}`, 'layout');
    return r;
  });
}

export async function saveAudiencesAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const report = await db.customReport.findUnique({ where: { id: v.id ?? '' } });
    if (!report) throw new ValidationError({ id: ['Unknown report'] });
    await saveReport.run(await getContext(), {
      id: report.id,
      name: report.name,
      audiences: {
        all: v.all === 'on',
        roleIds: fd.getAll('roleIds').map(String),
        cohortIds: fd.getAll('cohortIds').map(String),
        userIds: await usersByLogin(v.logins, 'logins'),
      },
    });
    revalidatePath(`/reports/${report.id}`, 'layout');
    return null;
  });
}

export async function deleteReportAction(id: string) {
  const r = await runAction(async () => {
    await deleteReport.run(await getContext(), { id });
    return null;
  });
  if (r.ok) redirect('/reports');
  return r;
}

export async function duplicateReportAction(id: string, name: string) {
  const r = await runAction(async () => duplicateReport.run(await getContext(), { id, name }));
  if (r.ok) redirect(`/reports/${r.data.id}/edit`);
  return r;
}

export async function saveScheduleAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveSchedule.run(await getContext(), {
      reportId: v.reportId ?? '',
      name: v.name ?? '',
      format: v.format === 'csv' ? 'csv' : 'xlsx',
      frequency: (v.frequency ?? 'WEEKLY') as never,
      hour: Number(v.hour ?? 8),
      day: Number(v.day || 1),
      toAudience: v.toAudience === 'on',
      userIds: await usersByLogin(v.logins, 'logins'),
      skipEmpty: v.skipEmpty === 'on',
      enabled: true,
    });
    revalidatePath(`/reports/${v.reportId}/edit`);
    return r;
  });
}

export async function deleteScheduleAction(reportId: string, id: string) {
  return runAction(async () => {
    await deleteSchedule.run(await getContext(), { id });
    revalidatePath(`/reports/${reportId}/edit`);
    return null;
  });
}

/** Sends a schedule's report now, as the schedule would. */
export async function sendScheduleAction(reportId: string, id: string) {
  return runAction(async () => {
    const ctx = await getContext();
    await ctx.perm.require('report:customise');
    const sent = await sendSchedule(db, id);
    revalidatePath(`/reports/${reportId}/edit`);
    return { sent };
  });
}
