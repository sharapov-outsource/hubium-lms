'use client';

import { Button } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { deleteRoleAction } from '@/server/actions/admin';

export function DeleteRoleButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations('admin.role');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">{tc('delete')}</Button>
      </DialogTrigger>
      <DialogContent title={tc('delete')} description={t('deleteConfirm', { name })}>
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
