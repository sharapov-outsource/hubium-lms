import 'server-only';
import { createAuth } from '@hubium/core/auth/auth';
import { nextCookies } from 'better-auth/next-js';
import { db } from './db';

export const auth = createAuth({
  db,
  baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  secret: process.env.APP_SECRET ?? '',
  extraPlugins: [nextCookies()],
});
