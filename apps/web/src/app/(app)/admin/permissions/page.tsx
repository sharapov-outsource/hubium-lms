import {
  capabilities,
  explain,
  getCapability,
  getContextChain,
  loadRoleDefinitions,
  loadUserAccess,
  roleName,
} from '@hubium/core';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Field,
  Input,
  PageHeader,
  Select,
} from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('admin.check', 'title');

export default async function PermissionCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; cap?: string; context?: string }>;
}) {
  await requireCapability('role:manage');
  const sp = await searchParams;
  const [t, locale] = await Promise.all([getTranslations('admin.check'), getLocale()]);
  const courses = await db.course.findMany({
    where: { deletedAt: null },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
    take: 500,
  });
  const categories = await db.category.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  let result: React.ReactNode = null;
  if (sp.user && sp.cap) {
    const login = sp.user.trim().toLowerCase();
    const user = await db.user.findFirst({
      where: { OR: [{ email: login }, { username: login }], deletedAt: null },
    });
    if (!user) result = <Alert variant="destructive">{t('userNotFound')}</Alert>;
    else if (capabilities.has(sp.cap as never)) {
      const contextId = sp.context || SYSTEM_CONTEXT_ID;
      const [access, chain, defs] = await Promise.all([
        loadUserAccess(db, user),
        getContextChain(db, contextId),
        loadRoleDefinitions(db),
      ]);
      const ex = explain({ actor: access, cap: sp.cap, def: getCapability(sp.cap), chain, defs });
      const roles = await db.role.findMany({
        where: { id: { in: ex.roles.map((r) => r.roleId) } },
      });
      const roleLabel = (id: string) => {
        const r = roles.find((x) => x.id === id);
        return r ? roleName(r, locale) : id;
      };
      const ctxName = (id: string) =>
        id === SYSTEM_CONTEXT_ID
          ? t('contextSystem')
          : (courses.find((c) => c.id === id)?.fullName ??
            categories.find((c) => c.id === id)?.name ??
            id.slice(0, 8));
      result = (
        <Alert variant={ex.result ? 'success' : 'destructive'}>
          <p className="flex items-center gap-2 font-medium">
            <Badge variant={ex.result ? 'success' : 'destructive'}>
              {ex.result ? t('allowed') : t('denied')}
            </Badge>
            {t(`reasons.${ex.reason}`)}
          </p>
          {ex.roles.length ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {ex.roles.map((r) => (
                <li key={r.roleId}>
                  {t('roleRow', {
                    role: roleLabel(r.roleId),
                    at: ctxName(r.at),
                    base: r.base ?? '—',
                    final: r.final ?? '—',
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      );
    }
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Card className="mb-6">
        <CardContent className="pt-5">
          <form className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Field label={t('user')} htmlFor="user">
              <Input id="user" name="user" defaultValue={sp.user} required />
            </Field>
            <Field label={t('capability')} htmlFor="cap">
              <Select id="cap" name="cap" defaultValue={sp.cap}>
                {[...capabilities.keys()].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('context')} htmlFor="context">
              <Select id="context" name="context" defaultValue={sp.context ?? ''}>
                <option value="">{t('contextSystem')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    📁 {c.name}
                  </option>
                ))}
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit">{t('run')}</Button>
          </form>
        </CardContent>
      </Card>
      {result}
    </>
  );
}
