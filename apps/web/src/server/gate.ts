import { accountGate, GATE_PAGES } from '@hubium/core';
import type { NextRequest } from 'next/server';
import { db } from './db';
import { sessionToken } from './session-cookie';

/**
 * Where a signed-in person must go before the page they asked for (accountGate), for
 * proxy.ts. The app layout checks too, but a layout is not rendered again when the menu
 * moves between its pages, so without this a step could be walked around.
 */
export async function gateRedirect(req: NextRequest): Promise<string | null> {
  const token = sessionToken(req.cookies.getAll());
  if (!token) return null;
  const session = await db.session
    .findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: {
        impersonatedBy: true,
        user: {
          select: {
            id: true,
            status: true,
            isSiteAdmin: true,
            mustChangePassword: true,
            twoFactorEnabled: true,
          },
        },
      },
    })
    .catch(() => null);
  // while logged in as someone, their steps stay theirs
  if (!session || session.impersonatedBy || session.user.status !== 'ACTIVE') return null;
  const gate = await accountGate(db, session.user);
  if (!gate) return null;
  const page = GATE_PAGES[gate];
  return req.nextUrl.pathname === new URL(page, req.url).pathname ? null : page;
}
