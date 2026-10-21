'use client';

import { useTranslations } from 'next-intl';
import { CommandButton } from '@/components/confirm-button';
import { acceptConflictAction, dismissConflictAction } from '@/server/actions/nodes';

export function ConflictActions({ id }: { id: string }) {
  const t = useTranslations('nodes');
  return (
    <div className="flex flex-wrap gap-2">
      <CommandButton
        run={() => acceptConflictAction(id)}
        confirm={t('acceptConfirm')}
        success={t('accepted')}
      >
        {t('accept')}
      </CommandButton>
      <CommandButton
        variant="outline"
        run={() => dismissConflictAction(id)}
        confirm={t('dismissConfirm')}
        success={t('dismissed')}
      >
        {t('dismiss')}
      </CommandButton>
    </div>
  );
}
