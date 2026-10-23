'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { CommandButton } from '@/components/confirm-button';
import { deleteNodeAction, newNodeCodeAction, revokeNodeAction } from '@/server/actions/nodes';
import { InstallNotice } from './node-forms';

/** A new installation code: to install the node (again) on a server. */
export function NewCodeButton({ id, hub, label }: { id: string; hub: string; label: string }) {
  const [code, setCode] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      <CommandButton
        variant="outline"
        className="w-fit"
        run={() => newNodeCodeAction(id)}
        onDone={(r) => setCode(r.code)}
      >
        {label}
      </CommandButton>
      {code ? <InstallNotice code={code} hub={hub} /> : null}
    </div>
  );
}

export function RevokeNodeButton({ id }: { id: string }) {
  const t = useTranslations('nodes');
  return (
    <CommandButton
      variant="destructive"
      className="w-fit"
      run={() => revokeNodeAction(id)}
      confirm={t('revokeConfirm')}
      success={t('revoked')}
    >
      {t('revoke')}
    </CommandButton>
  );
}

export function DeleteNodeButton({ id }: { id: string }) {
  const t = useTranslations('nodes');
  return (
    <CommandButton
      variant="destructive"
      className="w-fit"
      run={() => deleteNodeAction(id)}
      confirm={t('deleteConfirm')}
    >
      {t('delete')}
    </CommandButton>
  );
}
