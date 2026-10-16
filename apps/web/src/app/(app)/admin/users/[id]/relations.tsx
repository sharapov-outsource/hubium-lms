'use client';

import type { RelatedUser } from '@hubium/core/users/relations';
import { Badge, Button, Input, Label, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import {
  addUserRelationAction,
  removeUserRelationAction,
  searchUsersAction,
} from '@/server/actions/mentors';

/** The admin user card's mentors and mentees, with a search to add a mentor or parent. */
export function UserRelations({
  userId,
  mentors,
  mentees,
}: {
  userId: string;
  mentors: RelatedUser[];
  mentees: RelatedUser[];
}) {
  const t = useTranslations('admin.user.relations');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [kind, setKind] = useState<'PARENT' | 'MENTOR'>('PARENT');

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    // an answer to an earlier query that arrives late is not shown
    let current = true;
    const h = setTimeout(async () => {
      const r = await searchUsersAction(q).catch(() => null);
      if (current && r?.ok) setFound(r.data.filter((u) => u.id !== userId));
    }, 250);
    return () => {
      current = false;
      clearTimeout(h);
    };
  }, [q, userId]);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.message ?? '');
        return;
      }
      setQ('');
      router.refresh();
    });

  const list = (people: RelatedUser[], side: 'mentor' | 'mentee', label: string) =>
    people.length ? (
      <div className="grid gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <ul className="grid gap-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <a href={`/admin/users/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </a>{' '}
                <Badge>{t(p.kind === 'PARENT' ? 'parent' : 'mentor')}</Badge>
              </span>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                aria-label={t('remove', { name: p.name })}
                onClick={() =>
                  run(() =>
                    side === 'mentor'
                      ? removeUserRelationAction(p.id, userId)
                      : removeUserRelationAction(userId, p.id),
                  )
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="grid gap-4">
      {list(mentors, 'mentor', t('mentors'))}
      {list(mentees, 'mentee', t('mentees'))}
      {!mentors.length && !mentees.length ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="rel-q">{t('add')}</Label>
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <Input
            id="rel-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            autoComplete="off"
          />
          <Select
            aria-label={t('kind')}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'PARENT' | 'MENTOR')}
          >
            <option value="PARENT">{t('parent')}</option>
            <option value="MENTOR">{t('mentor')}</option>
          </Select>
        </div>
        {found.length ? (
          <ul className="divide-y divide-border rounded-md border border-border" aria-live="polite">
            {found.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  disabled={pending}
                  className="flex w-full flex-wrap items-center gap-x-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => run(() => addUserRelationAction(u.id, userId, kind))}
                >
                  <span className="font-medium">{u.name}</span>
                  {u.email ? <span className="text-muted-foreground">{u.email}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
