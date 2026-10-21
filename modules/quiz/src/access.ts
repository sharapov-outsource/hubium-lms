import { safeEqual } from '@hubium/module-sdk/crypto';
import { ipInList } from '@hubium/module-sdk/net';

// Quiz access rules, as Moodle's: a password to start an attempt, network addresses an
// attempt may be taken from, and a wait between attempts; and the local nodes it may be
// taken through (an exam in the rooms of chosen branches). Pure functions; server.ts reads
// the settings and overrides and turns refusals into errors.

export interface AccessRules {
  /**
   * Passwords that start an attempt: the learner's own override's, else their groups',
   * else the quiz's. Empty: none needed.
   */
  passwords: string[];
  /** Address list (see ipInList); empty: anywhere. */
  subnet: string;
  /** Local nodes attempts may only be taken through; empty: through any or none. */
  nodeIds: string[];
  /** Wait after the first attempt, and after each later one, in seconds. */
  delay1Sec: number;
  delay2Sec: number;
}

export type AccessRefusal =
  | { reason: 'password' }
  | { reason: 'subnet' }
  | { reason: 'node' }
  | { reason: 'delay'; until: Date };

/**
 * The passwords that apply: an override's password wins over the quiz's ('' lifts it), a
 * learner's own over their groups'. With several groups any of their passwords works.
 */
export function effectivePasswords(
  quiz: string,
  own: string | null | undefined,
  groups: (string | null)[],
): string[] {
  if (own !== null && own !== undefined) return own ? [own] : [];
  const g = groups.filter((p): p is string => p !== null);
  if (g.length) return g.includes('') ? [] : [...new Set(g)];
  return quiz ? [quiz] : [];
}

/** When the next attempt may start, after `finished` attempts (oldest first). */
export function nextAttemptAt(rules: AccessRules, finished: (Date | null)[]): Date | null {
  const last = finished.at(-1);
  if (!last) return null;
  const wait = finished.length === 1 ? rules.delay1Sec : rules.delay2Sec;
  return wait > 0 ? new Date(last.getTime() + wait * 1000) : null;
}

export function networkAllowed(rules: Pick<AccessRules, 'subnet'>, ip: string | null): boolean {
  return !rules.subnet.trim() || ipInList(ip, rules.subnet);
}

/** Whether a request through this node (null: none, the cloud itself) may take attempts. */
export function nodeAllowed(rules: Pick<AccessRules, 'nodeIds'>, nodeId: string | null): boolean {
  return !rules.nodeIds.length || (!!nodeId && rules.nodeIds.includes(nodeId));
}

/** Why a new attempt may not start now, or null. Previews skip the wait. */
export function checkStart(
  rules: AccessRules,
  o: {
    ip: string | null;
    nodeId?: string | null;
    now: Date;
    finished: (Date | null)[];
    password?: string;
    preview: boolean;
  },
): AccessRefusal | null {
  if (!networkAllowed(rules, o.ip)) return { reason: 'subnet' };
  if (!nodeAllowed(rules, o.nodeId ?? null)) return { reason: 'node' };
  if (!o.preview) {
    const until = nextAttemptAt(rules, o.finished);
    if (until && o.now < until) return { reason: 'delay', until };
  }
  if (rules.passwords.length && !rules.passwords.some((p) => safeEqual(o.password ?? '', p)))
    return { reason: 'password' };
  return null;
}
