import {
  canViewUserCompetencies,
  listProfileFields,
  profileFieldLabel,
  userBadges,
} from '@hubium/core';
import { Avatar, Button, Card, CardContent } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { BadgeImage } from '@/components/badges/badge-image';
import { MessageUserButton } from '@/components/comms/message-buttons';
import { db } from '@/server/db';
import { getContext, getCurrentUser, requireUser } from '@/server/session';

export async function generateMetadata({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(userId) || !(await getCurrentUser())) return {};
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, deletedAt: true },
  });
  return user && !user.deletedAt ? { title: user.name } : {};
}

export default async function ProfilePage({ params }: { params: Promise<{ userId: string }> }) {
  const me = await requireUser();
  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(userId)) notFound();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) notFound();
  const ctx = await getContext();
  const t = await getTranslations();
  const isMe = me.id === user.id;
  const canAdmin = await ctx.perm.can('user:update');
  // the address and the login, which signs them in, for themselves and administrators
  const showContacts = isMe || canAdmin;
  const [locale, format] = await Promise.all([getLocale(), getFormatter()]);
  // custom fields: all for the person and administrators, the public ones for others
  const stored = (user.customFields ?? {}) as Record<string, string | boolean>;
  const details = (await listProfileFields(db))
    .filter((f) => (isMe || canAdmin || f.visibleToOthers) && stored[f.shortName] !== undefined)
    .map((f) => {
      const v = stored[f.shortName];
      const text =
        typeof v === 'boolean'
          ? t(v ? 'common.yes' : 'common.no')
          : f.type === 'date' && v
            ? format.dateTime(new Date(`${v}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' })
            : v;
      return { label: profileFieldLabel(f, locale), text };
    })
    .filter((d) => d.text !== '');
  // the badges they hold now
  const now = new Date();
  const badges = (await userBadges(db, user.id)).filter(
    (a) => !a.revokedAt && (!a.expiresAt || a.expiresAt > now),
  );
  return (
    <Card className="max-w-2xl">
      <CardContent className="flex flex-wrap items-center gap-5 pt-6">
        <Avatar name={user.name} src={user.image} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{user.name}</h1>
          {showContacts && !user.emailPlaceholder ? (
            <p className="text-sm text-muted-foreground">{user.email}</p>
          ) : null}
          {showContacts && user.username ? (
            <p className="text-sm text-muted-foreground">@{user.username}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          {isMe ? (
            <Button asChild variant="secondary">
              <Link href="/settings/account">{t('nav.settings')}</Link>
            </Button>
          ) : null}
          {!isMe && user.status === 'ACTIVE' ? <MessageUserButton userId={user.id} /> : null}
          {!isMe && (await canViewUserCompetencies(ctx, user.id)) ? (
            <Button asChild variant="secondary">
              <Link href={`/plans?user=${user.id}`}>{t('competencies.plansTitle')}</Link>
            </Button>
          ) : null}
          {canAdmin && !isMe ? (
            <Button asChild variant="secondary">
              <Link href={`/admin/users/${user.id}`}>{t('common.edit')}</Link>
            </Button>
          ) : null}
        </div>
        {details.length ? (
          <dl className="grid w-full gap-x-6 gap-y-2 border-t border-border pt-4 text-sm sm:grid-cols-[auto_1fr]">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="whitespace-pre-line">{d.text}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {badges.length ? (
          <section className="w-full border-t border-border pt-4">
            <h2 className="mb-2 text-sm font-medium">{t('badges.title')}</h2>
            <ul className="flex flex-wrap gap-3">
              {badges.map((a) => (
                <li key={a.id}>
                  <Link href={`/badge/${a.id}`} title={a.badge.name} className="block">
                    <BadgeImage badgeId={a.badgeId} name={a.badge.name} size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
