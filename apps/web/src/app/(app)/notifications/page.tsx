import { listNotifications } from '@hubium/core';
import { Avatar, PageHeader } from '@hubium/ui';
import { LinkTabs } from '@hubium/ui/tabs';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { uuidParam } from '@/lib/url-params';
import { db } from '@/server/db';
import { requireUser } from '@/server/session';
import { LiveRefresh, MarkAllReadButton, NotificationLink } from './parts';

export async function generateMetadata() {
  const t = await getTranslations('notifications');
  return { title: t('title') };
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unread?: string; before?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const unreadOnly = sp.unread === '1';
  const [t, format] = await Promise.all([getTranslations('notifications'), getFormatter()]);
  const page = await listNotifications(db, user.id, {
    unreadOnly,
    before: uuidParam(sp.before),
    limit: 30,
  });
  const base = unreadOnly ? '/notifications?unread=1' : '/notifications';
  return (
    <div className="max-w-3xl">
      <PageHeader title={t('title')} actions={<MarkAllReadButton />} />
      <LiveRefresh />
      <LinkTabs
        label={t('title')}
        active={unreadOnly ? 'unread' : 'all'}
        items={[
          { key: 'all', href: '/notifications', label: t('all') },
          { key: 'unread', href: '/notifications?unread=1', label: t('unreadOnly') },
        ]}
      />
      {page.items.length ? (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
          {page.items.map((n) => (
            <li key={n.id} className="flex gap-3 p-4">
              {n.actor ? (
                <Avatar name={n.actor.name} src={n.actor.image} size={36} />
              ) : (
                <span aria-hidden className="size-9 shrink-0 rounded-full bg-accent-soft" />
              )}
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="flex items-start gap-2">
                  {n.readAt ? null : (
                    <span className="mt-2 size-2 shrink-0 rounded-full bg-accent">
                      <span className="sr-only">{t('unreadOnly')}</span>
                    </span>
                  )}
                  {n.url ? (
                    <NotificationLink id={n.id} href={n.url} unread={!n.readAt}>
                      {n.title}
                    </NotificationLink>
                  ) : (
                    <span className={n.readAt ? '' : 'font-medium'}>{n.title}</span>
                  )}
                </div>
                {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                <time
                  dateTime={n.createdAt.toISOString()}
                  className="text-xs text-muted-foreground"
                >
                  {format.dateTime(n.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                </time>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {page.hasMore ? (
        <div className="mt-4">
          <Link
            href={`${base}${base.includes('?') ? '&' : '?'}before=${page.items.at(-1)!.id}`}
            className="text-sm text-accent hover:underline"
          >
            {t('loadMore')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
