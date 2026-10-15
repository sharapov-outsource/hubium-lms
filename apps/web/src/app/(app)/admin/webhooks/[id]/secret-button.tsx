'use client';

import { Button } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { rotateWebhookSecretAction } from '@/server/actions/webhooks';
import { SecretNotice } from '../webhook-form';

/** Replaces the signing secret after a confirmation and shows the new one once. */
export function RotateSecretButton({ id }: { id: string }) {
  const t = useTranslations('adminWebhooks');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            {t('rotate')}
          </Button>
        </DialogTrigger>
        <DialogContent title={tc('confirm')} description={t('rotateConfirm')}>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await rotateWebhookSecretAction(id);
                  setOpen(false);
                  if (!r.ok) toast.error(r.message);
                  else setSecret(r.data.secret);
                })
              }
            >
              {tc('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {secret ? (
        <div className="basis-full">
          <SecretNotice secret={secret} />
        </div>
      ) : null}
    </>
  );
}
