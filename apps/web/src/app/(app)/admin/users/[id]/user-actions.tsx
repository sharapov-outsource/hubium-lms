'use client';

import { Button, Card, CardContent, Checkbox } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import {
  assignSystemRoleAction,
  deleteUserAction,
  loginAsAction,
  setUserSuspendedAction,
  unlockUserAction,
} from '@/server/actions/admin';

export function SiteRoleToggles({
  userId,
  roles,
}: {
  userId: string;
  roles: { id: string; name: string; assigned: boolean }[];
}) {
  const [pending, start] = useTransition();
  const t = useTranslations('common');
  return (
    <ul className="grid gap-2">
      {roles.map((r) => (
        <li key={r.id}>
          <label htmlFor={`role-${r.id}`} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`role-${r.id}`}
              defaultChecked={r.assigned}
              disabled={pending}
              onChange={(e) => {
                const box = e.currentTarget;
                const assigned = box.checked;
                start(async () => {
                  const res = await assignSystemRoleAction(userId, r.id, assigned);
                  if (res.ok) toast.success(t('saved'));
                  else {
                    // refused: the box shows what is stored again
                    box.checked = !assigned;
                    toast.error(res.message);
                  }
                });
              }}
            />
            {r.name}
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Shown while the account is locked after failed sign-ins. */
export function LockedNotice({ userId, until }: { userId: string; until: string }) {
  const t = useTranslations('admin.user');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardContent className="grid gap-3 pt-5">
        <p className="text-sm">{t('lockedUntil', { until })}</p>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await unlockUserAction(userId);
              if (r.ok) toast.success(t('unlocked'));
              else toast.error(r.message);
              router.refresh();
            })
          }
        >
          {t('unlock')}
        </Button>
      </CardContent>
    </Card>
  );
}

export function DangerZone({
  userId,
  name,
  suspended,
  canDelete,
  canLoginAs,
}: {
  userId: string;
  name: string;
  suspended: boolean;
  canDelete: boolean;
  canLoginAs: boolean;
}) {
  const t = useTranslations('admin.user');
  const ta = useTranslations('admin');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardContent className="grid gap-2 pt-5">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await setUserSuspendedAction(userId, !suspended);
              if (!r.ok) toast.error(r.message);
              router.refresh();
            })
          }
        >
          {suspended ? t('unsuspend') : t('suspend')}
        </Button>
        {canLoginAs ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">{ta('loginAs')}</Button>
            </DialogTrigger>
            <DialogContent
              title={ta('loginAs')}
              description={ta('loginAsConfirm', { name })}
              closeLabel={tc('close')}
            >
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">{tc('cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await loginAsAction(userId);
                      if (!r.ok) toast.error(r.message);
                      // a full load drops everything cached for the administrator
                      else window.location.assign('/dashboard');
                    })
                  }
                >
                  {ta('loginAs')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
        {canDelete ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive">{tc('delete')}</Button>
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
                      const r = await deleteUserAction(userId);
                      if (r && !r.ok) toast.error(r.message);
                    })
                  }
                >
                  {tc('delete')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </CardContent>
    </Card>
  );
}
