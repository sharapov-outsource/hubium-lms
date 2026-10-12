import { Avatar, Button, Card, CardContent } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessageUserButton } from '@/components/comms/message-buttons';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

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
  const showEmail = isMe || canAdmin;
  return (
    <Card className="max-w-2xl">
      <CardContent className="flex flex-wrap items-center gap-5 pt-6">
        <Avatar name={user.name} src={user.image} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{user.name}</h1>
          {showEmail && !user.emailPlaceholder ? (
            <p className="text-sm text-muted-foreground">{user.email}</p>
          ) : null}
          {user.username ? <p className="text-sm text-muted-foreground">@{user.username}</p> : null}
        </div>
        <div className="flex gap-2">
          {isMe ? (
            <Button asChild variant="secondary">
              <Link href="/settings/account">{t('nav.settings')}</Link>
            </Button>
          ) : null}
          {!isMe && user.status === 'ACTIVE' ? <MessageUserButton userId={user.id} /> : null}
          {canAdmin && !isMe ? (
            <Button asChild variant="secondary">
              <Link href={`/admin/users/${user.id}`}>{t('common.edit')}</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
