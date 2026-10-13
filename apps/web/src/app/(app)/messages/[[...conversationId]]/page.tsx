import { getTranslations } from 'next-intl/server';
import {
  conversationInfoAction,
  conversationsAction,
  messagesAction,
} from '@/server/actions/comms';
import { requireUser } from '@/server/session';
import { Messenger } from './messenger';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ conversationId?: string[] }>;
}) {
  const [{ conversationId }, t] = await Promise.all([params, getTranslations('messages')]);
  const id = conversationId?.[0];
  // Only members get the conversation back; anyone else sees the plain section title.
  const info = id ? await conversationInfoAction(id).catch(() => null) : null;
  const name = info?.kind === 'SELF' ? t('self') : (info?.name ?? info?.other?.name);
  return { title: name ? `${name} · ${t('title')}` : t('title') };
}

export default async function MessagesPage({
  params,
}: {
  params: Promise<{ conversationId?: string[] }>;
}) {
  const user = await requireUser();
  const { conversationId } = await params;
  const id = conversationId?.[0];
  const [conversations, info, messages] = await Promise.all([
    conversationsAction(),
    id ? conversationInfoAction(id).catch(() => null) : null,
    id ? messagesAction(id).catch(() => null) : null,
  ]);
  return (
    <Messenger
      key={id ?? 'none'}
      me={{ id: user.id, name: user.name }}
      initialConversations={conversations}
      conversation={info}
      initialMessages={messages}
    />
  );
}
