'use client';

import { Input, Label } from '@hubium/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { CommandButton } from '@/components/confirm-button';
import { nodeCommandAction } from '@/server/actions/nodes';

/** The node admin's commands: work alone now, go back to the cloud, put the sync off. */
export function NodeCommands({ mode, postponed }: { mode: string; postponed: string | null }) {
  const t = useTranslations('nodes');
  const format = useFormatter();
  const [until, setUntil] = useState('');
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {mode === 'OFFLINE' ? (
          <CommandButton
            run={() => nodeCommandAction('online')}
            confirm={t('goOnlineConfirm')}
            success={t('commandDone')}
          >
            {t('goOnline')}
          </CommandButton>
        ) : (
          <CommandButton
            variant="outline"
            run={() => nodeCommandAction('offline')}
            confirm={t('goOfflineConfirm')}
            success={t('commandDone')}
          >
            {t('goOffline')}
          </CommandButton>
        )}
      </div>
      {mode === 'OFFLINE' ? (
        <div className="grid gap-2">
          <Label htmlFor="node-postpone">{t('postponeUntil')}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="node-postpone"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="w-60"
            />
            <CommandButton
              variant="outline"
              disabled={!until}
              run={() => nodeCommandAction('postpone', new Date(until).toISOString())}
              success={t('commandDone')}
            >
              {t('postpone')}
            </CommandButton>
          </div>
          {postponed ? (
            <p className="text-sm text-muted-foreground">
              {t('postponedTill', {
                at: format.dateTime(new Date(postponed), {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                }),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
