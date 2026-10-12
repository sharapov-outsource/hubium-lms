'use client';

import { Button } from '@hubium/ui';
import { CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useTransition } from 'react';
import { useLiveCounts } from '@/components/comms/live-counts';
import { useRealtime } from '@/components/realtime';
import { markNotificationsReadAction } from '@/server/actions/comms';

export function MarkAllReadButton() {
  const t = useTranslations('notifications');
  const router = useRouter();
  const { counts, refresh } = useLiveCounts();
  const [pending, start] = useTransition();
  if (!counts.notifications) return null;
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markNotificationsReadAction({ all: true });
          refresh();
          router.refresh();
        })
      }
    >
      <CheckCheck aria-hidden />
      {t('markAllRead')}
    </Button>
  );
}

/** Link to the notification target that marks it read on the way. */
export function NotificationLink({
  id,
  href,
  unread,
  children,
}: {
  id: string;
  href: string;
  unread: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={() => {
        if (unread) void markNotificationsReadAction({ ids: [id] });
      }}
      className={unread ? 'font-medium hover:underline' : 'hover:underline'}
    >
      {children}
    </Link>
  );
}

/** Re-renders the list when notifications arrive or are read elsewhere. */
export function LiveRefresh() {
  const router = useRouter();
  useRealtime(['notification.new', 'notification.read', 'reconnect'], () => router.refresh());
  return null;
}
