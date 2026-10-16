import type { Readable } from 'node:stream';
import { buildModuleCtx, getAllSettings, isModuleEnabled } from '@hubium/core';
import { getStorage } from '@hubium/core/files/storage';
import { AssignSettings, isBlind, markedBy, participantNumbers } from '@hubium/mod-assign/server';
import { Zip, ZipPassThrough } from 'fflate';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * All latest submissions of an assignment as a ZIP: one folder per student or team (the
 * students the marker marks, with allocation). While marking is blind a student's folder
 * goes by the participant number. A team's work whose group was deleted has no owner left:
 * it goes to "no_owner", for those who see every group. The archive is streamed, stored
 * files as they are, not held in memory.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await params;
  const ctx = await getContext();
  const found = /^[0-9a-f-]{36}$/.test(activityId)
    ? await db.activity.findUnique({
        where: { id: activityId },
        include: { course: { select: { deletedAt: true } } },
      })
    : null;
  // an assignment in the bin, or in a course in the bin, has nothing to download
  if (found?.moduleKey !== 'assign' || found.deletedAt || found.course.deletedAt)
    return new Response('Not found', { status: 404 });
  const { course: _course, ...a } = found;
  if (!isModuleEnabled(await getAllSettings(db), 'assign'))
    return new Response('Not found', { status: 404 });
  if (!(await ctx.perm.can('mod.assign:grade', a.id)))
    return new Response('Forbidden', { status: 403 });
  const assign = {
    ...a,
    settings: AssignSettings.parse(a.settings),
  } as Parameters<typeof isBlind>[1];
  const all = await db.assignSubmission.findMany({
    where: { activityId, latest: true, status: { in: ['SUBMITTED', 'DRAFT'] } },
    include: {
      user: { select: { name: true, username: true, id: true } },
      group: { select: { name: true, id: true, members: { select: { userId: true } } } },
    },
  });
  const ownersOf = (s: (typeof all)[number]) =>
    s.userId ? [s.userId] : (s.group?.members.map((m) => m.userId) ?? []);
  const mctx = buildModuleCtx(ctx);
  const mine = new Set(await markedBy(mctx, assign, all.flatMap(ownersOf)));
  const seesAll = await ctx.perm.can('group:accessall', a.courseId);
  const subs = all.filter((s) =>
    !s.userId && !s.group ? seesAll : ownersOf(s).some((u) => mine.has(u)),
  );
  const hide =
    (await isBlind(db, assign)) && !(await ctx.perm.can('mod.assign:viewblinddetails', a.id));
  const numbers = hide
    ? await participantNumbers(
        db,
        a.id,
        subs.flatMap((s) => (s.userId ? [s.userId] : [])),
      )
    : new Map<string, number>();
  const files = await db.file.findMany({
    where: {
      contextId: activityId,
      component: 'mod.assign',
      area: 'submission',
      itemId: { in: subs.map((s) => s.id) },
    },
    include: { blob: true },
  });
  // refused before anything is sent
  if (files.reduce((n, f) => n + Number(f.size), 0) > MAX_BYTES)
    return new Response('Archive too large', { status: 413 });

  const folderOf = (s: (typeof subs)[number]) =>
    s.user
      ? hide
        ? `Participant_${numbers.get(s.user.id)}`
        : `${safe(s.user.name)}_${s.user.username ?? s.user.id.slice(0, 8)}`
      : s.group
        ? `${safe(s.group.name)}_${s.group.id.slice(0, 8)}`
        : `no_owner/submission_${s.id.slice(0, 8)}`;
  const storage = getStorage();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (err) controller.error(err);
        else {
          controller.enqueue(chunk);
          if (final) controller.close();
        }
      });
      const add = async (path: string, source: AsyncIterable<unknown> | Uint8Array) => {
        const entry = new ZipPassThrough(path);
        zip.add(entry);
        if (source instanceof Uint8Array) entry.push(source, true);
        else {
          for await (const c of source)
            entry.push(
              Buffer.isBuffer(c) ? new Uint8Array(c) : new Uint8Array(Buffer.from(c as string)),
            );
          entry.push(new Uint8Array(0), true);
        }
      };
      try {
        for (const s of subs) {
          const folder = folderOf(s);
          if (s.onlineText)
            await add(
              `${folder}/onlinetext.html`,
              new TextEncoder().encode(`<!doctype html><meta charset="utf-8">${s.onlineText}`),
            );
          for (const f of files.filter((x) => x.itemId === s.id))
            await add(
              `${folder}/${safe(f.name)}`,
              (await storage.getStream(f.blob.storageKey)) as Readable,
            );
        }
        zip.end();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safe(a.name)}.zip`)}`,
    },
  });
}
