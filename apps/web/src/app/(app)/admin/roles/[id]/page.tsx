import { capabilities, capabilityComponent } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { updateRoleAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { viewerCan } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { RoleForm } from '../role-form';
import { CapabilityMatrix, DeleteRoleButton } from './matrix';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await viewerCan('role:manage'))) return {};
  const [role, locale] = await Promise.all([
    db.role.findUnique({ where: { id }, select: { name: true, shortName: true } }),
    getLocale(),
  ]);
  return role ? { title: (role.name as Record<string, string>)[locale] ?? role.shortName } : {};
}

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability('role:manage');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const role = await db.role.findUnique({
    where: { id },
    include: { capabilities: true, _count: { select: { assignments: true } } },
  });
  if (!role) notFound();
  const [t, locale] = await Promise.all([getTranslations('admin.role'), getLocale()]);
  const names = role.name as Record<string, string>;
  const current = Object.fromEntries(role.capabilities.map((c) => [c.capability, c.permission]));
  const groups = new Map<string, { cap: string; risk: string[] }[]>();
  for (const [cap, def] of capabilities) {
    const g = capabilityComponent(cap);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ cap, risk: [...(def.risk ?? [])] });
  }
  return (
    <>
      <PageHeader
        title={names[locale] ?? role.shortName}
        description={`${role.shortName} · ${t(`archetypes.${role.archetype}`)}`}
        actions={
          !role.isProtected && role._count.assignments === 0 ? (
            <DeleteRoleButton id={role.id} name={names[locale] ?? role.shortName} />
          ) : null
        }
      />
      <div className="grid gap-6">
        <Card>
          <CardContent className="pt-5">
            <RoleForm
              action={updateRoleAction}
              role={{
                id: role.id,
                nameRu: names.ru ?? '',
                nameEn: names.en ?? '',
                levels: role.assignableLevels,
                isProtected: role.isProtected,
              }}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('capabilities')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CapabilityMatrix roleId={role.id} groups={[...groups.entries()]} current={current} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
