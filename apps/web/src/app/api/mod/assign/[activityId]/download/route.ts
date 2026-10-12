import type { Readable } from 'node:stream';
import { getStorage } from '@hubium/core/files/storage';
import { zipSync } from 'fflate';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return new Uint8Array(Buffer.concat(chunks));
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);

/** All latest submissions of an assignment as a ZIP: one folder per student. */
export async function GET(_req: Request, { params }: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await params;
  const ctx = await getContext();
  const a = /^[0-9a-f-]{36}$/.test(activityId)
    ? await db.activity.findUnique({ where: { id: activityId } })
    : null;
  if (a?.moduleKey !== 'assign') return new Response('Not found', { status: 404 });
  if (!(await ctx.perm.can('mod.assign:grade', a.id)))
    return new Response('Forbidden', { status: 403 });
  const subs = await db.assignSubmission.findMany({
    where: { activityId, latest: true, status: { in: ['SUBMITTED', 'DRAFT'] } },
    include: { user: { select: { name: true, username: true, id: true } } },
  });
  const storage = getStorage();
  const entries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const s of subs) {
    const folder = `${safe(s.user.name)}_${s.user.username ?? s.user.id.slice(0, 8)}`;
    if (s.onlineText)
      entries[`${folder}/onlinetext.html`] = new TextEncoder().encode(
        `<!doctype html><meta charset="utf-8">${s.onlineText}`,
      );
    const files = await db.file.findMany({
      where: { contextId: activityId, component: 'mod.assign', area: 'submission', itemId: s.id },
      include: { blob: true },
    });
    for (const f of files) {
      total += Number(f.size);
      if (total > 500 * 1024 * 1024) return new Response('Archive too large', { status: 413 });
      entries[`${folder}/${safe(f.name)}`] = await readAll(
        (await storage.getStream(f.blob.storageKey)) as Readable,
      );
    }
  }
  const zip = zipSync(entries, { level: 0 });
  return new Response(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safe(a.name)}.zip`)}`,
    },
  });
}
