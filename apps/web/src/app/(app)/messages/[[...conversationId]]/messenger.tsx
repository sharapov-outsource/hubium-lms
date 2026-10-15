'use client';

import { Avatar, Button, Field, Input, Textarea } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Dialog, DialogContent, DialogTrigger } from '@hubium/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { toast } from '@hubium/ui/theme';
import {
  ArrowLeft,
  EllipsisVertical,
  FileIcon,
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { useLiveCounts } from '@/components/comms/live-counts';
import { useRealtime } from '@/components/realtime';
import {
  blockUserAction,
  type ClientMessage,
  conversationStateAction,
  conversationsAction,
  createGroupConversationAction,
  deleteMessageAction,
  markConversationReadAction,
  messagesAction,
  openDirectAction,
  searchPeopleAction,
  sendMessageAction,
} from '@/server/actions/comms';

/** Server actions accept 10 MB per request; leave room for the rest of the form. */
const MAX_ATTACHMENTS_BYTES = 9 * 1024 * 1024;

type Conversation = Awaited<ReturnType<typeof conversationsAction>>[number];
type Info = {
  id: string;
  kind: 'DIRECT' | 'GROUP' | 'SELF';
  name: string | null;
  groupId: string | null;
  muted: boolean;
  blocked: boolean;
  iBlocked: boolean;
  other: { id: string; name: string; image: string | null } | null;
  members: { id: string; name: string; image: string | null }[];
};
type Person = { id: string; name: string; image: string | null };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Messenger({
  me,
  initialConversations,
  conversation,
  initialMessages,
}: {
  me: { id: string; name: string };
  initialConversations: Conversation[];
  conversation: Info | null;
  initialMessages: { items: ClientMessage[]; hasMore: boolean } | null;
}) {
  const t = useTranslations('messages');
  const [conversations, setConversations] = useState(initialConversations);
  const { refresh: refreshCounts } = useLiveCounts();
  const reloadList = () => void conversationsAction().then(setConversations, () => {});
  useRealtime(['message.new', 'message.read', 'reconnect'], reloadList);

  return (
    <div className="-mx-4 -mt-6 grid h-[calc(100dvh-3.5rem-4rem)] border-border sm:-mx-6 lg:-mb-10 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[20rem_1fr]">
      <aside
        className={cn(
          'flex min-h-0 flex-col border-border lg:border-r',
          conversation ? 'hidden lg:flex' : 'flex',
        )}
        aria-label={t('title')}
      >
        <ConversationList me={me} conversations={conversations} activeId={conversation?.id} />
      </aside>
      <section className={cn('min-h-0 flex-col', conversation ? 'flex' : 'hidden lg:flex')}>
        {conversation && initialMessages ? (
          <Thread
            me={me}
            info={conversation}
            initial={initialMessages}
            onActivity={() => {
              reloadList();
              refreshCounts();
            }}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-sm text-muted-foreground">
            {t('selectConversation')}
          </div>
        )}
      </section>
    </div>
  );
}

function title(c: { kind: string; name: string | null; otherName?: string | null }, self: string) {
  return c.kind === 'SELF' ? self : (c.name ?? c.otherName ?? '…');
}

function ConversationList({
  me,
  conversations,
  activeId,
}: {
  me: { id: string; name: string };
  conversations: Conversation[];
  activeId?: string;
}) {
  const t = useTranslations('messages');
  const format = useFormatter();
  // "5 minutes ago" must keep moving while the page stays open.
  const now = useNow({ updateInterval: 60_000 });
  const router = useRouter();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [people, setPeople] = useState<Person[]>([]);
  const [, start] = useTransition();
  useEffect(() => {
    if (dq.length < 2) {
      setPeople([]);
      return;
    }
    let live = true;
    void searchPeopleAction(dq).then((r) => live && setPeople(r));
    return () => {
      live = false;
    };
  }, [dq]);
  const shown = q
    ? conversations.filter((c) =>
        title(c, t('self')).toLocaleLowerCase().includes(q.toLocaleLowerCase()),
      )
    : conversations;
  const open = (userId: string) =>
    start(async () => {
      const r = await openDirectAction(userId);
      if (!r.ok) toast.error(r.message ?? t('cannotMessage'));
      else router.push(`/messages/${r.data.id}`);
    });
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('search')}
            className="pl-8"
          />
        </div>
        <NewGroupDialog />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {people.length ? (
          <ul aria-label={t('search')} className="border-b border-border py-1">
            {people.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => open(p.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Avatar name={p.name} src={p.image} size={32} />
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {shown.length ? (
          <ul>
            {shown.map((c) => {
              const name = title(c, t('self'));
              return (
                <li key={c.id}>
                  <Link
                    href={`/messages/${c.id}`}
                    aria-current={c.id === activeId ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 hover:bg-muted',
                      c.id === activeId && 'bg-accent-soft',
                    )}
                  >
                    {c.kind === 'GROUP' ? (
                      <span
                        aria-hidden
                        className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                      >
                        <Users className="size-5" />
                      </span>
                    ) : (
                      <Avatar name={name} src={c.otherImage} size={40} />
                    )}
                    <span className="grid min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn('flex-1 truncate text-sm', c.unread ? 'font-semibold' : '')}
                        >
                          {name}
                        </span>
                        {c.lastMessageAt ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {format.relativeTime(new Date(c.lastMessageAt), now)}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="flex-1 truncate text-xs text-muted-foreground">
                          {c.lastSenderId === me.id ? `${t('you')}: ` : ''}
                          {c.lastBody ?? ''}
                        </span>
                        {c.unread ? (
                          <span className="rounded-full bg-accent px-1.5 text-xs leading-5 text-accent-foreground">
                            <span className="sr-only">{t('unread', { n: c.unread })}</span>
                            <span aria-hidden>{c.unread}</span>
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{t('noConversations')}</p>
        )}
      </div>
    </>
  );
}

function NewGroupDialog() {
  const t = useTranslations('messages');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [found, setFound] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (dq.length < 2) return setFound([]);
    // an answer to an earlier query that arrives late is not shown
    let current = true;
    void searchPeopleAction(dq)
      .then((people) => {
        if (current) setFound(people);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [dq]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="outline" aria-label={t('newGroup')}>
          <Plus aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent title={t('newGroup')} closeLabel={tc('close')}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('name') ?? '');
            start(async () => {
              const r = await createGroupConversationAction({
                name,
                userIds: picked.map((p) => p.id),
              });
              if (!r.ok) return void toast.error(r.message);
              setOpen(false);
              router.push(`/messages/${r.data.id}`);
            });
          }}
        >
          <Field label={t('groupName')} htmlFor="g-name">
            <Input id="g-name" name="name" required maxLength={100} />
          </Field>
          <Field label={t('members')} htmlFor="g-search">
            <Input
              id="g-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchPlaceholder')}
            />
          </Field>
          {picked.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                    className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
                  >
                    {p.name}
                    <X className="size-3" aria-label={tc('remove')} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {found.length ? (
            <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
              {found
                .filter((f) => !picked.some((p) => p.id === f.id))
                .map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setPicked([...picked, f])}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <Avatar name={f.name} src={f.image} size={24} />
                      {f.name}
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}
          <Button type="submit" disabled={pending || !picked.length} className="w-fit">
            {t('create')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Thread({
  me,
  info,
  initial,
  onActivity,
}: {
  me: { id: string; name: string };
  info: Info;
  initial: { items: ClientMessage[]; hasMore: boolean };
  onActivity: () => void;
}) {
  const t = useTranslations('messages');
  const tc = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const [messages, setMessages] = useState(initial.items);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [typing, setTyping] = useState<{ name: string; until: number } | null>(null);
  const [sending, start] = useTransition();
  const inFlight = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastTyping = useRef(0);
  const typingUser = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const name = info.kind === 'SELF' ? t('self') : (info.name ?? info.other?.name ?? t('groupChat'));

  const markRead = () => {
    if (document.visibilityState === 'visible') {
      void markConversationReadAction(info.id).then(onActivity);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per conversation
  useEffect(() => {
    markRead();
    const onVisible = () => markRead();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [info.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll after each change
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  // Realtime handlers outlive renders: read the newest list through a ref.
  const latest = useRef(messages);
  latest.current = messages;
  const merge = (cur: ClientMessage[], items: ClientMessage[], where: 'start' | 'end') => {
    const known = new Set(cur.map((m) => m.id));
    const add = items.filter((m) => !known.has(m.id));
    return where === 'end' ? [...cur, ...add] : [...add, ...cur];
  };
  const fetchNew = async () => {
    // After a reconnect there may be more than one page of new messages.
    for (let page = 0; page < 20; page++) {
      const last = latest.current.at(-1)?.id;
      const r = await messagesAction(info.id, last ? { after: last } : {});
      if (!r.items.length) return;
      latest.current = merge(latest.current, r.items, 'end');
      setMessages((cur) => merge(cur, r.items, 'end'));
      if (!r.hasMore || !last) return;
    }
  };
  const reloadRecent = async () => {
    const r = await messagesAction(info.id);
    setMessages((cur) => {
      const fresh = new Map(r.items.map((m) => [m.id, m]));
      const older = cur.filter((m) => !fresh.has(m.id) && m.id < (r.items[0]?.id ?? ''));
      return [...older, ...r.items];
    });
  };

  useRealtime('message.new', (d) => {
    if (d.conversationId !== info.id) return;
    if (d.deleted) void reloadRecent();
    else void fetchNew().then(markRead);
    if (d.senderId && d.senderId === typingUser.current) setTyping(null);
  });
  useRealtime('reconnect', () => void fetchNew());
  useRealtime('typing', (d) => {
    if (d.conversationId !== info.id || d.userId === me.id) return;
    typingUser.current = String(d.userId);
    setTyping({ name: String(d.name ?? ''), until: Date.now() + 4000 });
  });
  useEffect(() => {
    if (!typing) return;
    const id = setTimeout(() => setTyping(null), typing.until - Date.now());
    return () => clearTimeout(id);
  }, [typing]);

  const loadOlder = async () => {
    const first = messages[0]?.id;
    if (!first) return;
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    const r = await messagesAction(info.id, { before: first });
    stickToBottom.current = false;
    setMessages((cur) => merge(cur, r.items, 'start'));
    setHasMore(r.hasMore);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const send = () => {
    const form = formRef.current;
    // Enter pressed again before the answer: the button is disabled, the key is not
    if (!form || sending || inFlight.current) return;
    const fd = new FormData(form);
    fd.delete('files');
    for (const f of files) fd.append('files', f);
    if (!String(fd.get('body') ?? '').trim() && !files.length) return;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENTS_BYTES)
      return void toast.error(t('attachmentsTooLarge'));
    stickToBottom.current = true;
    inFlight.current = true;
    start(async () => {
      try {
        const r = await sendMessageAction(fd).catch(() => null);
        if (!r) return void toast.error(tc('error'));
        if (!r.ok) return void toast.error(r.message);
        form.reset();
        setFiles([]);
        lastTyping.current = 0;
        await fetchNew();
        onActivity();
      } finally {
        inFlight.current = false;
      }
    });
  };

  const pingTyping = () => {
    const now = Date.now();
    if (now - lastTyping.current < 3000) return;
    lastTyping.current = now;
    void fetch('/api/messages/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: info.id }),
    }).catch(() => {});
  };

  const run = (p: Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    void p.then((r) => {
      if (!r.ok) toast.error(r.message ?? '');
      else {
        after?.();
        router.refresh();
      }
    });

  const blocked = info.blocked;
  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-3 py-2">
        <Link
          href="/messages"
          className="grid size-9 place-items-center rounded-md hover:bg-muted lg:hidden"
          aria-label={t('back')}
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        {info.kind === 'GROUP' ? (
          <span
            aria-hidden
            className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground"
          >
            <Users className="size-4" />
          </span>
        ) : (
          <Avatar name={name} src={info.other?.image} size={36} />
        )}
        <div className="grid min-w-0 flex-1">
          <h1 className="truncate font-semibold">{name}</h1>
          {info.kind === 'GROUP' ? (
            <span className="truncate text-xs text-muted-foreground">
              {info.members.map((m) => m.name).join(', ')}
            </span>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="grid size-9 place-items-center rounded-md hover:bg-muted"
            aria-label={t('members')}
          >
            <EllipsisVertical className="size-5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                run(conversationStateAction({ conversationId: info.id, muted: !info.muted }))
              }
            >
              {info.muted ? t('unmute') : t('mute')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                run(conversationStateAction({ conversationId: info.id, archived: true }), () =>
                  router.push('/messages'),
                )
              }
            >
              {t('archive')}
            </DropdownMenuItem>
            {info.kind === 'DIRECT' && info.other ? (
              <DropdownMenuItem
                onSelect={() => run(blockUserAction(info.other!.id, !info.iBlocked))}
              >
                {info.iBlocked ? t('unblock') : t('block')}
              </DropdownMenuItem>
            ) : null}
            {info.kind === 'GROUP' && !info.groupId ? (
              <DropdownMenuItem
                onSelect={() =>
                  run(conversationStateAction({ conversationId: info.id, leave: true }), () =>
                    router.push('/messages'),
                  )
                }
              >
                {t('leave')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6"
      >
        {hasMore ? (
          <div className="mb-4 text-center">
            <Button size="sm" variant="ghost" onClick={() => void loadOlder()}>
              {t('loadOlder')}
            </Button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : null}
        <ol className="grid gap-2" aria-live="polite" aria-relevant="additions">
          {messages.map((m, i) => {
            const mine = m.senderId === me.id;
            const showName =
              info.kind === 'GROUP' && !mine && messages[i - 1]?.senderId !== m.senderId;
            return (
              <li key={m.id} className={cn('group flex', mine ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'grid max-w-[85%] gap-1 sm:max-w-[70%]',
                    mine && 'justify-items-end',
                  )}
                >
                  {showName ? (
                    <span className="px-1 text-xs text-muted-foreground">{m.senderName}</span>
                  ) : null}
                  <div className="flex items-end gap-1">
                    {mine && !m.deleted ? (
                      <button
                        type="button"
                        onClick={() => run(deleteMessageAction(m.id), () => void reloadRecent())}
                        // hidden until hovered, but in the tab order and shown when focused;
                        // always shown where there is no hover (touch screens)
                        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                        aria-label={t('delete')}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    ) : null}
                    <div
                      className={cn(
                        'rounded-2xl px-3 py-2 text-sm',
                        mine
                          ? 'rounded-br-sm bg-accent text-accent-foreground'
                          : 'rounded-bl-sm bg-muted text-foreground',
                      )}
                    >
                      {m.deleted ? (
                        <span className="italic opacity-80">{t('deleted')}</span>
                      ) : (
                        <span className="whitespace-pre-wrap break-words">{m.body}</span>
                      )}
                      {m.attachments.length ? (
                        <ul className="mt-1 grid gap-1">
                          {m.attachments.map((a) => (
                            <li key={a.id}>
                              <a
                                href={a.url}
                                className="inline-flex items-center gap-1 underline underline-offset-2"
                              >
                                <FileIcon className="size-3.5" aria-hidden />
                                {a.name}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                  <time dateTime={m.createdAt} className="px-1 text-[11px] text-muted-foreground">
                    {format.dateTime(new Date(m.createdAt), { timeStyle: 'short' })}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 h-5 text-xs text-muted-foreground" aria-live="polite">
          {typing ? t('typing', { name: typing.name }) : ''}
        </p>
      </div>
      {blocked ? (
        <p className="border-t border-border p-4 text-center text-sm text-muted-foreground">
          {t('blocked')}
        </p>
      ) : (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="grid gap-2 border-t border-border p-3"
        >
          <input type="hidden" name="conversationId" value={info.id} />
          {files.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${f.size}-${f.lastModified}`}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {f.name}
                  <button
                    type="button"
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    aria-label={`${t('delete')} ${f.name}`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-2">
            <label
              className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted"
              title={t('attach')}
            >
              <Paperclip className="size-5" aria-hidden />
              <span className="sr-only">{t('attach')}</span>
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5));
                  e.target.value = '';
                }}
              />
            </label>
            <Textarea
              name="body"
              rows={1}
              placeholder={t('write')}
              aria-label={t('write')}
              className="max-h-40 min-h-9 flex-1 resize-none py-2"
              onChange={pingTyping}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button type="submit" size="icon" disabled={sending} aria-label={t('send')}>
              <SendHorizontal aria-hidden />
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
