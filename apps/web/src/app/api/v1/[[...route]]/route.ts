import { createApi } from '@hubium/api';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

const api = createApi({
  db,
  origin: process.env.APP_URL?.replace(/\/+$/, ''),
  // unset or empty means the default; 0 would block every request
  rateLimitPerMinute: Number(process.env.API_RATE_LIMIT_PER_MIN) || 120,
});

const handle = (req: Request) => api.fetch(req);

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
