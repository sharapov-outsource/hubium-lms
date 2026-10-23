import { newOpRecord, newSeed, withWriteScope } from '@hubium/db';
import type { ActivityModule } from '@hubium/module-sdk';
import type { RequestContext } from '../context.ts';
import { journaling, writeJournal } from '../node/journal.ts';
import { buildModuleCtx } from './module-ctx.ts';

// A request to a module's content on the content origin (SCORM, H5P): what the person does
// in the content (a POST: a commit, a result) is their change, an operation; a view writes
// side records at most. A local node working alone records the POSTs in its journal, and
// the cloud replays them through the same function (node/replay.ts).

export interface ContentGrant {
  activityId: string;
  userId: string;
  data: Record<string, string | number>;
  token: string;
}

/** What the journal keeps of a content request, to make it again. */
export interface ContentInput {
  data: Record<string, string | number>;
  path: string[];
  method: string;
  url: string;
  contentType: string | null;
  body: string;
}

export async function runContent(
  ctx: RequestContext,
  m: ActivityModule<unknown>,
  grant: ContentGrant,
  req: Request,
  path: string[],
  /** The cloud replaying a node's entry: its seed. */
  replaySeed?: string,
): Promise<Response> {
  const change = req.method === 'POST';
  const name = `${m.key}.content`;
  if (!change)
    return withWriteScope('touch', name, () => m.content!(buildModuleCtx(ctx), grant, req, path));
  const record = journaling() ? newOpRecord(false) : undefined;
  const seed = replaySeed ?? newSeed();
  const body = record ? await req.clone().text() : '';
  return withWriteScope(
    'operation',
    name,
    async () => {
      const res = await m.content!(buildModuleCtx(ctx), grant, req, path);
      if (record && res.ok) {
        const input: ContentInput = {
          data: grant.data,
          path,
          method: req.method,
          url: req.url,
          contentType: req.headers.get('content-type'),
          body,
        };
        await writeJournal(
          ctx.db,
          {
            kind: 'content',
            name,
            activityId: grant.activityId,
            actor: { kind: 'user', userId: grant.userId },
            input,
            at: ctx.now,
            seed,
          },
          record,
        );
      }
      return res;
    },
    { now: ctx.now, seed, record },
  );
}
