import 'server-only';
import { type Condition, listProfileFields, profileFieldLabel } from '@hubium/core';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { db } from '../db';

/** Human-readable list of unmet availability conditions. */
export async function describeConditions(conditions: Condition[]): Promise<string> {
  if (!conditions.length) return '';
  const [t, format] = await Promise.all([getTranslations('activity'), getFormatter()]);
  const actIds = conditions.flatMap((c) =>
    c.type === 'completion' || c.type === 'grade' ? [c.activityId] : [],
  );
  const groupIds = conditions.flatMap((c) => (c.type === 'group' && c.groupId ? [c.groupId] : []));
  const groupingIds = conditions.flatMap((c) => (c.type === 'grouping' ? [c.groupingId] : []));
  const groupings = groupingIds.length
    ? await db.grouping.findMany({
        where: { id: { in: groupingIds } },
        select: { id: true, name: true },
      })
    : [];
  const custom = conditions.some((c) => c.type === 'profile' && c.field.startsWith('cf:'))
    ? await listProfileFields(db)
    : [];
  const locale = await getLocale();
  const fieldName = (field: string) => {
    if (!field.startsWith('cf:')) return t(`profileFields.${field as 'email'}`);
    const f = custom.find((x) => x.shortName === field.slice(3));
    return f ? profileFieldLabel(f, locale) : field.slice(3);
  };
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
      case 'grouping':
        return t('condGrouping', {
          name: groupings.find((g) => g.id === c.groupingId)?.name ?? '…',
        });
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
          field: fieldName(c.field),
          op: t(`profileOps.${c.op}`),
          value: c.value,
        });
    }
    return '';
  };
  return conditions.map(one).join('; ');
}
