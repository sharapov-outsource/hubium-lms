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
import { uuidParam } from '@/lib/url-params';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { ContextPick } from './context-pick';

export const generateMetadata = titled('admin.check', 'title');

export default async function PermissionCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; cap?: string; context?: string }>;
}) {
  await requireCapability('role:manage');
  const sp = await searchParams;
  const [t, locale] = await Promise.all([getTranslations('admin.check'), getLocale()]);
  const contextId = uuidParam(sp.context);
  // names of the contexts the page mentions, not of every course and category: the
  // context field searches them as it is typed
  const names = async (ids: string[]) => {
    const [courses, categories] = await Promise.all([
      db.course.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }),
      db.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    ]);
    return new Map<string, string>([
      ...courses.map((c) => [c.id, c.fullName] as [string, string]),
      ...categories.map((c) => [c.id, `📁 ${c.name}`] as [string, string]),
    ]);
  };
  const chosen = contextId ? (await names([contextId])).get(contextId) : undefined;
  let result: React.ReactNode = null;
  if (sp.user && sp.cap) {
    const login = sp.user.trim().toLowerCase();
    const user = await db.user.findFirst({
      where: { OR: [{ email: login }, { username: login }], deletedAt: null },
    });
    if (!user) result = <Alert variant="destructive">{t('userNotFound')}</Alert>;
    else if (capabilities.has(sp.cap as never)) {
      const [access, chain, defs] = await Promise.all([
        loadUserAccess(db, user),
        getContextChain(db, contextId ?? SYSTEM_CONTEXT_ID),
        loadRoleDefinitions(db),
      ]);
      const ex = explain({ actor: access, cap: sp.cap, def: getCapability(sp.cap), chain, defs });
      const [roles, at] = await Promise.all([
        db.role.findMany({ where: { id: { in: ex.roles.map((r) => r.roleId) } } }),
        names(ex.roles.map((r) => r.at)),
      ]);
      const roleLabel = (id: string) => {
        const r = roles.find((x) => x.id === id);
        return r ? roleName(r, locale) : id;
      };
      const ctxName = (id: string) =>
        id === SYSTEM_CONTEXT_ID
          ? t('contextSystem')
          : (at.get(id)?.replace(/^📁 /, '') ?? id.slice(0, 8));
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
              <ContextPick
                site={t('contextSystem')}
                chosen={contextId && chosen ? { value: contextId, label: chosen } : null}
              />
            </Field>
            <Button type="submit">{t('run')}</Button>
          </form>
        </CardContent>
      </Card>
      {result}
    </>
  );
}
