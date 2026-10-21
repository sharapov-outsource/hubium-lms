import { removePushSubscription, savePushSubscription, toActionError } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return Response.json(
      await savePushSubscription.run(await getContext(), {
        ...body,
        userAgent: req.headers.get('user-agent'),
      }),
    );
  } catch (e) {
    return Response.json(toActionError(e), { status: 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { endpoint } = (await req.json()) as { endpoint?: string };
    return Response.json(
      await removePushSubscription.run(await getContext(), { endpoint: String(endpoint ?? '') }),
    );
  } catch (e) {
    return Response.json(toActionError(e), { status: 400 });
  }
}
