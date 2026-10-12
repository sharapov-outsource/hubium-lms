import 'server-only';
import type { Condition } from '@hubium/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '../db';

/** Human-readable list of unmet availability conditions. */
export async function describeConditions(conditions: Condition[]): Promise<string> {
  if (!conditions.length) return '';
  const [t, format] = await Promise.all([getTranslations('activity'), getFormatter()]);
  const actIds = conditions.flatMap((c) =>
    c.type === 'completion' || c.type === 'grade' ? [c.activityId] : [],
  );
  const groupIds = conditions.flatMap((c) => (c.type === 'group' && c.groupId ? [c.groupId] : []));
  const [acts, groups] = await Promise.all([
    actIds.length
      ? db.activity.findMany({ where: { id: { in: actIds } }, select: { id: true, name: true } })
      : [],
    groupIds.length
      ? db.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const name = (id: string) => acts.find((a) => a.id === id)?.name ?? '…';
  const one = (c: Condition): string => {
    switch (c.type) {
      case 'date':
        return t('condDate', {
          op: c.op === '>=' ? t('dateFrom') : t('dateUntil'),
          date: format.dateTime(new Date(c.at), { dateStyle: 'medium', timeStyle: 'short' }),
        });
      case 'completion':
        return t('condCompletion', {
          name: name(c.activityId),
          state: t(`completionStates.${c.state}`),
        });
      case 'group':
        return c.groupId
          ? t('condGroup', { name: groups.find((g) => g.id === c.groupId)?.name ?? '…' })
          : t('condAnyGroup');
      case 'grade':
        return t('condGrade', {
          name: name(c.activityId),
          range: [
            c.min !== undefined ? `≥ ${c.min}%` : '',
            c.max !== undefined ? `< ${c.max}%` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      case 'profile':
        return t('condProfile', {
          field: t(`profileFields.${c.field}`),
          op: t(`profileOps.${c.op}`),
          value: c.value,
        });
    }
    return '';
  };
  return conditions.map(one).join('; ');
}
