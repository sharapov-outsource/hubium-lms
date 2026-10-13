'use client';

import { Alert, Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { stopLoginAsAction } from '@/server/actions/admin';

/** Shown on every page of a "log in as" session, with the way back. */
export function LoginAsBanner({ name }: { name: string }) {
  const t = useTranslations('admin');
  const [pending, start] = useTransition();
  return (
    <Alert variant="warning" className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <span>{t('impersonating', { name })}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await stopLoginAsAction();
            if (!r.ok) toast.error(r.message);
            else window.location.assign(`/admin/users/${r.data.userId}`);
          })
        }
      >
        {t('stopImpersonating')}
      </Button>
    </Alert>
  );
}
