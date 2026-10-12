'use client';

import { Button, Card, CardContent } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Subscribes this browser to Web Push via the service worker. */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const t = useTranslations('notifications.prefs');
  const [state, setState] = useState<'loading' | 'unsupported' | 'on' | 'off'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window))
      return setState('unsupported');
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => setState(s ? 'on' : 'off'));
  }, []);

  async function enable() {
    if ((await Notification.requestPermission()) !== 'granted')
      return void toast.error(t('pushDenied'));
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toKey(publicKey),
    });
    const r = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!r.ok) throw new Error('subscribe failed');
    setState('on');
    toast.success(t('pushOn'));
  }

  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setState('off');
    toast.success(t('pushOff'));
  }

  if (state === 'loading') return null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
        <div>
          <p className="font-medium">{t('pushTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {state === 'unsupported' ? t('pushUnsupported') : t('pushHint')}
          </p>
        </div>
        {state === 'unsupported' ? null : (
          <Button
            variant={state === 'on' ? 'outline' : 'primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await (state === 'on' ? disable() : enable());
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {state === 'on' ? t('pushDisable') : t('pushEnable')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
