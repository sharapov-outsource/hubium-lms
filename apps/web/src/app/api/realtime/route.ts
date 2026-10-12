import { subscribeRealtime } from '@hubium/core/realtime';
import '@/server/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events for the signed-in user: notifications, messages, typing.
 * Events carry ids only; clients refetch details (and everything after a reconnect).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response('Unauthorized', { status: 401 });
  const userId = session.user.id;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send('retry: 3000\n: connected\n\n');
      const off = subscribeRealtime(userId, (e) =>
        send(`id: ${e.id}\nevent: ${e.t}\ndata: ${JSON.stringify(e.d ?? {})}\n\n`),
      );
      const heartbeat = setInterval(() => send(': hb\n\n'), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        off();
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
