'use client';

import { Button, Textarea } from '@hubium/ui';
import { Dialog, DialogContent, DialogTrigger } from '@hubium/ui/dialog';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { revokeBadgeAwardAction } from '@/server/actions/badges';

/** Revokes an award, with the reason its assertion will give. */
export function RevokeAwardButton({
  awardId,
  courseId,
  name,
}: {
  awardId: string;
  courseId: string | null;
  name: string;
}) {
  const t = useTranslations('badges');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`${t('revoke')}: ${name}`}>
          {t('revoke')}
        </Button>
      </DialogTrigger>
      <DialogContent title={`${t('revoke')}: ${name}`} closeLabel={tc('close')}>
        <ActionForm
          action={revokeBadgeAwardAction}
          success={t('revokedDone')}
          onSuccess={() => setOpen(false)}
          className="grid gap-3"
        >
          <input type="hidden" name="awardId" value={awardId} />
          {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
          <FormField name="reason" label={t('revokeReason')} id={`reason-${awardId}`}>
            <Textarea id={`reason-${awardId}`} name="reason" required maxLength={500} />
          </FormField>
          <div>
            <SubmitButton variant="destructive">{t('revoke')}</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
