import type { Db } from '@hubium/db';
import { ForbiddenError } from '../errors.ts';
import { pendingPolicies } from '../privacy/privacy.ts';
import { getSetting } from '../settings/settings.ts';

/**
 * A step someone must take before using the site: accept new mandatory policies, replace
 * a password an administrator set or that has expired, or, for administrators when the
 * site requires it, turn on two-factor sign-in. Pages, server actions and API tokens all
 * stop until it is taken; an administrator logged in as someone is not held by it.
 */
export type AccountGate = 'POLICIES' | 'PASSWORD' | 'TWO_FACTOR';

/** The page where each step is taken. */
export const GATE_PAGES: Record<AccountGate, string> = {
  POLICIES: '/policies',
  PASSWORD: '/settings/security?required=password',
  TWO_FACTOR: '/settings/security?required=2fa',
};

const GATE_MESSAGES: Record<AccountGate, string> = {
  POLICIES: 'Accept the site policies first',
  PASSWORD: 'Change your password first',
  TWO_FACTOR: 'Turn on two-factor sign-in first',
};

/** The step the person has to take first, if any. */
export async function accountGate(
  db: Db,
  user: {
    id: string;
    isSiteAdmin: boolean;
    mustChangePassword: boolean;
    twoFactorEnabled: boolean;
  },
): Promise<AccountGate | null> {
  if ((await pendingPolicies(db, user.id)).length) return 'POLICIES';
  if (user.mustChangePassword) return 'PASSWORD';
  if (
    user.isSiteAdmin &&
    !user.twoFactorEnabled &&
    (await getSetting(db, 'auth.require2faForAdmins'))
  )
    return 'TWO_FACTOR';
  return null;
}

/** The refusal of anything but the step itself. */
export function gateError(gate: AccountGate): ForbiddenError {
  return new ForbiddenError(GATE_MESSAGES[gate], { gate });
}
