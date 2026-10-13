import { capabilities, capabilityComponent, listRoleOverrides, roleName } from '@hubium/core';
import { Alert, Badge, Card, CardContent } from '@hubium/ui';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { getContext } from '@/server/session';
import { CapabilityMatrix } from './capability-matrix';

/**
 * Role overrides of one context (category, course or activity): pick a role, then set each
 * capability to inherit, allow, deny or prohibit. `path` is the page's own URL.
 */
export async function OverridesPanel({
  contextId,
  path,
  roleId,
}: {
  contextId: string;
  path: string;
  roleId?: string;
}) {
  const ctx = await getContext();
  if (!(await ctx.perm.can('role:review', contextId))) forbidden();
  const [data, canEdit, roles, t, locale] = await Promise.all([
    listRoleOverrides.run(ctx, { contextId }),
    ctx.perm.can('role:override', contextId),
    db.role.findMany({ orderBy: { sortOrder: 'asc' }, include: { capabilities: true } }),
    getTranslations('permissions'),
    getLocale(),
  ]);
  const role = roles.find((r) => r.id === roleId) ?? roles.find((r) => r.shortName === 'student');
  if (!role) return null;
  const counts = new Map<string, number>();
  for (const o of data.overrides) counts.set(o.roleId, (counts.get(o.roleId) ?? 0) + 1);
  const allowed = new Set<string>(data.capabilities);
  const groups = new Map<string, { cap: string; risk: string[] }[]>();
  for (const [cap, def] of capabilities) {
    if (!allowed.has(cap)) continue;
    const g = capabilityComponent(cap);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ cap, risk: [...(def.risk ?? [])] });
  }
  const name = (r: { name: unknown; shortName: string }) => roleName(r, locale);
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <Alert>{t('hint')}</Alert>
        {canEdit ? null : <Alert variant="warning">{t('readOnly')}</Alert>}
        <nav aria-label={t('role')} className="flex flex-wrap gap-2">
          {roles.map((r) => {
            const n = counts.get(r.id) ?? 0;
            const active = r.id === role.id;
            return (
              <Link
                key={r.id}
                href={`${path}?role=${r.id}`}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                  active
                    ? 'border-accent bg-accent-soft font-medium'
                    : 'border-border hover:border-accent'
                }`}
              >
                {name(r)}
                {n ? <Badge variant="accent">{n}</Badge> : null}
              </Link>
            );
          })}
        </nav>
        <CapabilityMatrix
          key={role.id}
          target={{ kind: 'override', roleId: role.id, contextId }}
          groups={[...groups.entries()]}
          current={Object.fromEntries(
            data.overrides
              .filter((o) => o.roleId === role.id)
              .map((o) => [o.capability, o.permission]),
          )}
          defaults={Object.fromEntries(role.capabilities.map((c) => [c.capability, c.permission]))}
          readOnly={!canEdit}
        />
      </CardContent>
    </Card>
  );
}
