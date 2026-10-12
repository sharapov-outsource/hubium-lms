'use client';

import { Button } from '@hubium/ui';
import { useTransition } from 'react';
import { revokeOtherSessionsAction, revokeSessionAction } from '@/server/actions/account';

export function RevokeButtons({
  token,
  all,
  label,
}: {
  token?: string;
  all?: boolean;
  label: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(
          async () =>
            void (all ? await revokeOtherSessionsAction() : await revokeSessionAction(token!)),
        )
      }
    >
      {label}
    </Button>
  );
}
