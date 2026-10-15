import { ForbiddenError } from '@hubium/core';
import { forbidden } from 'next/navigation';

/** Turns the core's refusal into the 403 page; any other error goes on. */
export function forbiddenOnDenied(e: unknown): never {
  if (e instanceof ForbiddenError) forbidden();
  throw e;
}
