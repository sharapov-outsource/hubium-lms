import { AppError, askTutor, toActionError } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = {
  VALIDATION: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
};

/**
 * Streams a tutor answer as NDJSON (one TutorEvent per line). Checks (feature, consent,
 * limits, quiz lock) run before the first byte so they come back as a JSON error.
 */
export async function POST(req: Request) {
  const ctx = await getContext();
  if (ctx.actor.kind !== 'user')
    return Response.json({ ok: false, code: 'UNAUTHENTICATED' }, { status: 401 });
  let body: { courseId?: string; conversationId?: string | null; message?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, code: 'BAD_REQUEST' }, { status: 400 });
  }
  const events = askTutor(ctx, {
    courseId: String(body.courseId ?? ''),
    conversationId: body.conversationId ?? null,
    message: String(body.message ?? ''),
  });
  let first: IteratorResult<unknown>;
  try {
    first = await events.next();
  } catch (e) {
    const err = toActionError(e, ctx.locale);
    // details tell the UI which notice to show (consent, quiz lock, limit kind)
    const details = e instanceof AppError ? e.details : undefined;
    return Response.json({ ...err, details }, { status: STATUS[err.code] ?? 500 });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`));
      try {
        if (!first.done) send(first.value);
        for await (const ev of events) send(ev);
      } catch (e) {
        const err = toActionError(e, ctx.locale);
        send({ type: 'error', code: err.code, message: err.message });
      } finally {
        controller.close();
      }
    },
    cancel() {
      void events.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
