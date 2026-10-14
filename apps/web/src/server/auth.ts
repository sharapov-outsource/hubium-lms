import 'server-only';
import { createAuthHolder, forwardingAuth } from '@hubium/core/auth/holder';
import { nextCookies } from 'better-auth/next-js';
import { db } from './db';

// Rebuilt when custom OAuth providers change (see holder.ts); `auth` always forwards to
// the current instance.
const holder = createAuthHolder({
  db,
  baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  secret: process.env.APP_SECRET ?? '',
  extraPlugins: [nextCookies()],
});

export const auth = forwardingAuth(holder);
export const authReady = holder.ready;
