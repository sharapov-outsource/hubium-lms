import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares a submitted secret (a quiz password, an enrolment key) with the expected one in
 * constant time, so response timing does not reveal how much of it was right.
 */
export function safeEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
