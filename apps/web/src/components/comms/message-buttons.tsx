'use client';

import { Button, type ButtonProps } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { MessageSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { openDirectAction, openGroupChatAction } from '@/server/actions/comms';

/** Opens (or creates) a direct conversation and navigates to it. */
export function MessageUserButton({ userId, ...props }: { userId: string } & ButtonProps) {
  const t = useTranslations('messages');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      {...props}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await openDirectAction(userId);
          if (!r.ok) toast.error(t('cannotMessage'));
          else router.push(`/messages/${r.data.id}`);
        })
      }
    >
      <MessageSquare aria-hidden />
      {t('messageUser')}
    </Button>
  );
}

export function GroupChatButton({ groupId, ...props }: { groupId: string } & ButtonProps) {
  const t = useTranslations('messages');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      {...props}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await openGroupChatAction(groupId);
          if (!r.ok) toast.error(r.message);
          else router.push(`/messages/${r.data.id}`);
        })
      }
    >
      <MessageSquare aria-hidden />
      {t('groupChat')}
    </Button>
  );
}
