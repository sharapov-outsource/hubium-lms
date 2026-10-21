import {
  buildModuleCtx,
  contentOrigin,
  getAllSettings,
  getModule,
  isModuleEnabled,
  Permissions,
  type RequestContext,
  siteLocale,
  verifyContentToken,
} from '@hubium/core';
import { withWriteScope } from '@hubium/db';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Untrusted content (SCORM, H5P) on the content origin. Answered only on CONTENT_HOST when
 * it is configured; the signed token in the path is the only credential (no cookies).
 */
async function handle(
  req: Request,
  { params }: { params: Promise<{ token: string; path: string[] }> },
) {
  if (process.env.CONTENT_HOST) {
    const want = new URL(contentOrigin()).host;
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (host !== want) return new Response('Not found', { status: 404 });
  }
  const { token, path } = await params;
  const grant = verifyContentToken(token);
  if (!grant) return new Response('Link expired', { status: 403 });
  const activity = await db.activity.findUnique({
    where: { id: grant.a },
    select: { moduleKey: true, deletedAt: true },
  });
  const m = activity && !activity.deletedAt ? getModule(activity.moduleKey) : undefined;
  const settings = await getAllSettings(db);
  if (!m?.content || !isModuleEnabled(settings, m.key))
    return new Response('Not found', { status: 404 });
  const ctx: RequestContext = {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: siteLocale(settings),
    origin: 'WEB',
  };
  // what the user does in the content (a commit, a result) is their change; a view
  // writes side records at most
  const write = req.method === 'POST' ? 'operation' : 'touch';
  return withWriteScope(write, `${m.key}.content`, () =>
    m.content!(
      buildModuleCtx(ctx),
      { activityId: grant.a, userId: grant.u, data: grant.d ?? {}, token },
      req,
      path,
    ),
  );
}

export { handle as GET, handle as POST };
