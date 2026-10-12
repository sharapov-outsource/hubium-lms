'use client';

import { Badge, Button, Select } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { deleteRoleAction, setRoleCapabilityAction } from '@/server/actions/admin';

type Perm = 'ALLOW' | 'PROHIBIT' | 'INHERIT';

export function CapabilityMatrix({
  roleId,
  groups,
  current,
}: {
  roleId: string;
  groups: [string, { cap: string; risk: string[] }[]][];
  current: Record<string, string>;
}) {
  const t = useTranslations('admin.role');
  const tc = useTranslations('common');
  const [values, setValues] = useState<Record<string, string>>(current);
  const [filter, setFilter] = useState('');
  const [, start] = useTransition();

  function change(cap: string, perm: Perm) {
    const prev = values[cap];
    setValues((v) => ({ ...v, [cap]: perm }));
    start(async () => {
      const r = await setRoleCapabilityAction(roleId, cap, perm);
      if (r.ok) toast.success(tc('saved'));
      else {
        toast.error(r.message);
        setValues((v) => ({ ...v, [cap]: prev ?? 'INHERIT' }));
      }
    });
  }

  return (
    <div className="grid gap-4">
      <label htmlFor="cap-filter" className="sr-only">
        {tc('search')}
      </label>
      <input
        id="cap-filter"
        className="h-9 max-w-xs rounded-md border border-input bg-background px-3 text-sm"
        placeholder={tc('searchPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {groups.map(([group, caps]) => {
        const visible = caps.filter((c) => c.cap.includes(filter.trim()));
        if (!visible.length) return null;
        return (
          <section key={group}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visible.map(({ cap, risk }) => {
                const v = (values[cap] ?? 'INHERIT') as Perm;
                return (
                  <li
                    key={cap}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm">{cap}</code>
                      {risk.map((r) => (
                        <Badge key={r} variant="warning">
                          {r}
                        </Badge>
                      ))}
                    </span>
                    <Select
                      aria-label={cap}
                      className="h-8 w-40"
                      value={v}
                      onChange={(e) => change(cap, e.target.value as Perm)}
                    >
                      <option value="INHERIT">{t('inherit')}</option>
                      <option value="ALLOW">{t('allow')}</option>
                      <option value="PROHIBIT">{t('prohibit')}</option>
                    </Select>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function DeleteRoleButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations('admin.role');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">{tc('delete')}</Button>
      </DialogTrigger>
      <DialogContent
        title={tc('delete')}
        description={t('deleteConfirm', { name })}
        closeLabel={tc('close')}
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tc('cancel')}</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await deleteRoleAction(id);
                if (r && !r.ok) toast.error(r.message);
              })
            }
          >
            {tc('delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
