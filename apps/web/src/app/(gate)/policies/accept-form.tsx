'use client';

import { Button, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { acceptPoliciesAction } from '@/server/actions/privacy';

export function AcceptPoliciesForm({ versionIds }: { versionIds: string[] }) {
  const t = useTranslations('policies');
  const router = useRouter();
  const [agree, setAgree] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3">
      <label htmlFor="policies-agree" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="policies-agree"
          checked={agree}
          onChange={(e) => setAgree(e.currentTarget.checked)}
        />
        {t('agree')}
      </label>
      <Button
        className="w-fit"
        disabled={!agree || pending}
        onClick={() =>
          start(async () => {
            const r = await acceptPoliciesAction(versionIds);
            if (!r.ok) return void toast.error(r.message);
            router.replace('/dashboard');
          })
        }
      >
        {t('continue')}
      </Button>
    </div>
  );
}
