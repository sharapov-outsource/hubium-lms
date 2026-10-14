import { auth, authReady } from '@/server/auth';

// Requests wait for the first instance with the custom OAuth providers.
async function handler(request: Request) {
  await authReady;
  return auth.handler(request);
}

export const GET = handler;
export const POST = handler;
