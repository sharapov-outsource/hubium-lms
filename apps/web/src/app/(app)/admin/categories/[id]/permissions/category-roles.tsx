'use client';

import { Button, Input, Label, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { assignCategoryRoleAction } from '@/server/actions/admin';
import { searchUsersAction } from '@/server/actions/mentors';

type Holder = { id: string; name: string };

/** Who holds which role in a category, with a search to give one. */
export function CategoryRoles({
  categoryId,
  roles,
  canAssign,
}: {
  categoryId: string;
  roles: { id: string; name: string; users: Holder[] }[];
  canAssign: boolean;
}) {
  const t = useTranslations('permissions');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    // an answer to an earlier query that arrives late is not shown
    let current = true;
    const h = setTimeout(async () => {
      const r = await searchUsersAction(q).catch(() => null);
      if (current && r?.ok) setFound(r.data);
    }, 250);
    return () => {
      current = false;
      clearTimeout(h);
    };
  }, [q]);

  const set = (userId: string, role: string, assigned: boolean) =>
    start(async () => {
      const r = await assignCategoryRoleAction(categoryId, userId, role, assigned);
      if (!r.ok) return void toast.error(r.message);
      setQ('');
      router.refresh();
    });

  return (
    <div className="grid gap-4">
      {roles.map((role) => (
        <div key={role.id} className="grid gap-1.5">
          <p className="text-sm font-medium">{role.name}</p>
          {role.users.length ? (
            <ul className="grid gap-1">
              {role.users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 text-sm">
                  <a href={`/admin/users/${u.id}`} className="hover:underline">
                    {u.name}
                  </a>
                  {canAssign ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={pending}
                      aria-label={t('removeHolder', { role: role.name, name: u.name })}
                      onClick={() => set(u.id, role.id, false)}
                    >
                      <X />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('nobody')}</p>
          )}
        </div>
      ))}
      {canAssign && roles.length ? (
        <div className="grid gap-2">
          <Label htmlFor="cat-role-q">{t('addPerson')}</Label>
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
            <Input
              id="cat-role-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchPerson')}
              autoComplete="off"
            />
            <Select
              aria-label={t('role')}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          {found.length ? (
            <ul
              className="divide-y divide-border rounded-md border border-border"
              aria-live="polite"
            >
              {found.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    disabled={pending}
                    aria-label={t('giveRole', { name: u.name })}
                    onClick={() => set(u.id, roleId, true)}
                  >
                    <span className="font-medium">{u.name}</span>
                    {u.email ? <span className="text-muted-foreground"> · {u.email}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
