import type { Prisma } from '@hubium/db';
import type { ActivityRef } from '@hubium/module-sdk';
import { userGroupIds } from '@hubium/module-sdk/groups';
import type { AssignSettingsT } from './config.ts';

// Team submissions: a team is a group of the assignment's grouping (all the course's
// groups without one). A student in no group submits alone, unless the assignment
// requires a group; a student in several groups cannot submit until a teacher fixes it.
// This differs from Moodle on purpose: Moodle puts every student without a group into one
// shared "default team".

export type Team =
  | { kind: 'individual' }
  | { kind: 'team'; groupId: string; name: string }
  | { kind: 'blocked'; reason: 'noGroup' | 'severalGroups' };

type Db = Pick<Prisma.TransactionClient, 'groupMember' | 'group'>;

export async function teamOf(
  db: Db,
  a: ActivityRef<AssignSettingsT>,
  userId: string,
): Promise<Team> {
  if (!a.settings.teamSubmission) return { kind: 'individual' };
  const groups = await userGroupIds(db, a, userId);
  if (groups.length > 1) return { kind: 'blocked', reason: 'severalGroups' };
  if (!groups.length)
    return a.settings.preventSubmissionNotInGroup
      ? { kind: 'blocked', reason: 'noGroup' }
      : { kind: 'individual' };
  const g = await db.group.findUniqueOrThrow({
    where: { id: groups[0]! },
    select: { id: true, name: true },
  });
  return { kind: 'team', groupId: g.id, name: g.name };
}

/** Where a student's submission lives: their own, or their team's. */
export const ownerOf = (userId: string, team: Team) =>
  team.kind === 'team' ? { groupId: team.groupId } : { userId };
