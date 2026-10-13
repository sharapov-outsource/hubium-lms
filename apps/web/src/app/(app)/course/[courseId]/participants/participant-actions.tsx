'use client';

import { DateInput } from '@hubium/module-sdk/form';
import { Button, Checkbox, Input, Label, Select } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { toast } from '@hubium/ui/theme';
import { MoreVertical, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import {
  enrolUsersAction,
  participantCommandAction,
  searchUsersToEnrolAction,
  setRolesAction,
} from '@/server/actions/courses';

export function EnrolDialog({
  courseId,
  roles,
}: {
  courseId: string;
  roles: { id: string; name: string; shortName: string }[];
}) {
  const t = useTranslations('participants');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<
    { id: string; name: string; email: string; emailPlaceholder: boolean }[]
  >([]);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [roleId, setRoleId] = useState(
    roles.find((r) => r.shortName === 'student')?.id ?? roles[0]?.id ?? '',
  );
  const [endsAt, setEndsAt] = useState('');
  const [pending, start] = useTransition();
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    const h = setTimeout(async () => {
      const r = await searchUsersToEnrolAction(courseId, q);
      if (r.ok) setFound(r.data);
    }, 250);
    return () => clearTimeout(h);
  }, [q, courseId]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus />
          {t('enrol')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('enrolTitle')}
        description={t('searchUsers')}
        closeLabel={tc('close')}
        className="max-w-xl"
      >
        <Label htmlFor="enrol-q" className="sr-only">
          {tc('search')}
        </Label>
        <Input
          id="enrol-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tc('searchPlaceholder')}
          autoFocus
        />
        <ul
          className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border"
          aria-live="polite"
        >
          {found.map((u) => (
            <li key={u.id}>
              <label htmlFor={`pick-${u.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Checkbox
                  id={`pick-${u.id}`}
                  checked={picked.has(u.id)}
                  onChange={(e) => {
                    const next = new Map(picked);
                    if (e.target.checked) next.set(u.id, u.name);
                    else next.delete(u.id);
                    setPicked(next);
                  }}
                />
                <span className="font-medium">{u.name}</span>
                {!u.emailPlaceholder ? (
                  <span className="text-muted-foreground">{u.email}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
        {picked.size ? <p className="text-sm">{[...picked.values()].join(', ')}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="enrol-role">{t('role')}</Label>
            <Select id="enrol-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="enrol-ends">{t('endsAt')}</Label>
            <DateInput id="enrol-ends" value={endsAt} onChange={setEndsAt} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tc('cancel')}</Button>
          </DialogClose>
          <Button
            disabled={!picked.size || pending}
            onClick={() =>
              start(async () => {
                const r = await enrolUsersAction(
                  courseId,
                  [...picked.keys()],
                  roleId,
                  endsAt || undefined,
                );
                if (!r.ok) return void toast.error(r.message);
                toast.success(t('enrolledN', { count: picked.size }));
                setPicked(new Map());
                setQ('');
                setOpen(false);
                router.refresh();
              })
            }
          >
            {t('enrol')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ParticipantActions({
  courseId,
  user,
  roles,
  current,
}: {
  courseId: string;
  user: { id: string; name: string; suspended: boolean };
  roles: { id: string; name: string }[];
  current: string[];
}) {
  const t = useTranslations('participants');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rolesOpen, setRolesOpen] = useState(false);
  const [unenrolOpen, setUnenrolOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(current));
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message ?? 'Error');
      router.refresh();
    });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${tc('actions')}: ${user.name}`}
            disabled={pending}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {roles.length ? (
            <DropdownMenuItem onSelect={() => setRolesOpen(true)}>
              {t('changeRoles')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              run(() =>
                participantCommandAction(
                  courseId,
                  user.id,
                  user.suspended ? 'activate' : 'suspend',
                ),
              )
            }
          >
            {user.suspended ? t('activate') : t('suspend')}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => setUnenrolOpen(true)}>
            {t('unenrol')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={rolesOpen} onOpenChange={setRolesOpen}>
        <DialogContent title={t('changeRoles')} description={user.name} closeLabel={tc('close')}>
          <div className="grid gap-2">
            {roles.map((r) => (
              <label
                key={r.id}
                htmlFor={`r-${user.id}-${r.id}`}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={`r-${user.id}-${r.id}`}
                  checked={selected.has(r.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    setSelected(next);
                  }}
                />
                {r.name}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              disabled={!selected.size || pending}
              onClick={() => {
                setRolesOpen(false);
                run(() => setRolesAction(courseId, user.id, [...selected]));
              }}
            >
              {tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={unenrolOpen} onOpenChange={setUnenrolOpen}>
        <DialogContent
          title={t('unenrol')}
          description={t('unenrolConfirm', { name: user.name })}
          closeLabel={tc('close')}
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setUnenrolOpen(false);
                run(() => participantCommandAction(courseId, user.id, 'unenrol'));
              }}
            >
              {t('unenrol')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
