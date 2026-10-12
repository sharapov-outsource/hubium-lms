'use client';

import { callModuleAction } from '@hubium/module-sdk/form';
import { Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ExternalLink, PhoneOff, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

export function JoinButton({ activityId, label }: { activityId: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="lg"
      disabled={pending}
      onClick={() =>
        start(async () => {
          // open the tab synchronously so popup blockers allow it
          const tab = window.open('about:blank', '_blank');
          const r = await callModuleAction<{ url: string }>(activityId, 'join', {});
          if (!r.ok || !r.data) {
            tab?.close();
            toast.error(r.message ?? 'Error');
            return;
          }
          if (tab) tab.location.href = r.data.url;
          else window.location.href = r.data.url;
          router.refresh();
        })
      }
    >
      <ExternalLink aria-hidden />
      {label}
    </Button>
  );
}

export function ModeratorButtons({
  activityId,
  live,
  record,
}: {
  activityId: string;
  live: boolean;
  record: boolean;
}) {
  const t = useTranslations('mod.livesession');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, ok: string) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, {});
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      toast.success(ok);
      router.refresh();
    });
  return (
    <div className="flex flex-wrap gap-2">
      {live ? (
        <Button variant="outline" disabled={pending} onClick={() => run('end', t('ended'))}>
          <PhoneOff aria-hidden />
          {t('end')}
        </Button>
      ) : null}
      {record ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => run('syncRecordings', t('synced'))}
        >
          <RefreshCw aria-hidden />
          {t('syncRecordings')}
        </Button>
      ) : null}
    </div>
  );
}
