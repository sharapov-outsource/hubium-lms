import { actionInputFromForm, runModuleAction, toActionError } from '@hubium/core';
import { getTranslations } from 'next-intl/server';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Generic endpoint for module actions (see callModuleAction in @hubium/module-sdk/form). */
export async function POST(req: Request) {
  const ctx = await getContext();
  if (ctx.actor.kind !== 'user')
    return Response.json(
      { ok: false, code: 'UNAUTHENTICATED', message: 'Sign in' },
      { status: 401 },
    );
  try {
    const fd = await req.formData();
    const activityId = String(fd.get('activityId') ?? '');
    const action = String(fd.get('action') ?? '');
    const input = await actionInputFromForm({
      input: fd.get('input'),
      filesField: fd.get('filesField'),
      files: fd.getAll('files'),
    });
    const data = await runModuleAction(ctx, activityId, action, input);
    return Response.json({ ok: true, data });
  } catch (e) {
    const r = toActionError(e);
    // module forms show only the message: say what was wrong (a file too big, malware, …),
    // and in the user's language when nothing more specific is known
    const why = Object.values(r.fieldErrors ?? {}).flat();
    if (why.length) return Response.json({ ...r, message: why.join('; ') });
    if (r.code === 'UNAVAILABLE' || r.code === 'INTERNAL')
      return Response.json({ ...r, message: (await getTranslations('errors'))(r.code) });
    return Response.json(r);
  }
}
