import { actionInputFromForm, runModuleAction, toActionError } from '@hubium/core';
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
    return Response.json(toActionError(e));
  }
}
