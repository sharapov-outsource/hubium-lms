'use client';

import { cn } from '@hubium/ui/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useRealtime } from '@/components/realtime';
import { markNotificationsReadAction, recentNotificationsAction } from '@/server/actions/comms';
import { useLiveCounts } from './live-counts';

type Item = Awaited<ReturnType<typeof recentNotificationsAction>>['items'][number];

export function NotificationBell() {
  const t = useTranslations('notifications');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { counts, refresh } = useLiveCounts();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [, start] = useTransition();
  const n = counts.notifications;

  const load = () =>
    start(async () => {
      setItems((await recentNotificationsAction()).items);
    });
  useRealtime(['notification.new', 'notification.read'], () => {
    if (open) load();
  });

  const read = (ids?: string[]) =>
    start(async () => {
      await markNotificationsReadAction(ids ? { ids } : { all: true });
      refresh();
      setItems((await recentNotificationsAction()).items);
    });

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) load();
      }}
    >
      <DropdownMenuTrigger
        className="relative grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={n ? t('bellUnread', { n }) : t('bell')}
      >
        <Bell className="size-5" aria-hidden />
        {n ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-foreground"
          >
            {n > 99 ? '99+' : n}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <DropdownMenuLabel className="p-0 text-sm font-semibold text-foreground">
            {t('title')}
          </DropdownMenuLabel>
          {n ? (
            <button
              type="button"
              onClick={() => read()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent hover:bg-muted"
            >
              <CheckCheck className="size-3.5" aria-hidden />
              {t('markAllRead')}
            </button>
          ) : null}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {items === null ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            items.map((it) => (
              <DropdownMenuItem key={it.id} asChild className="items-start">
                <Link
                  href={it.url ?? '/notifications'}
                  onClick={() => (it.readAt ? undefined : read([it.id]))}
                  className="flex gap-2 px-3 py-2"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      it.readAt ? 'bg-transparent' : 'bg-accent',
                    )}
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span
                      className={cn('text-sm', it.readAt ? 'text-muted-foreground' : 'font-medium')}
                    >
                      {it.title}
                    </span>
                    {it.body ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{it.body}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {format.relativeTime(new Date(it.createdAt), now)}
                    </span>
                  </span>
                </Link>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem asChild>
          <Link href="/notifications" className="justify-center px-3 py-2 text-sm text-accent">
            {t('viewAll')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
