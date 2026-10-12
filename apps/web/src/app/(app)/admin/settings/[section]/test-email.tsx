'use client';

import { Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTransition } from 'react';
import { sendTestEmailAction } from '@/server/actions/admin';

export function TestEmailButton({ label, done }: { label: string; done: string }) {
  const [pending, start] = useTransition();
  return (
    <div>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await sendTestEmailAction();
            if (r.ok) toast.success(done);
            else toast.error(r.message);
          })
        }
      >
        {label}
      </Button>
    </div>
  );
}
