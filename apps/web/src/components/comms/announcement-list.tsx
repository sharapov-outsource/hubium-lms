import { RichText } from '@hubium/editor/client';
import { Avatar, Badge } from '@hubium/ui';
import { Pin, PinOff, Trash2 } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AnnouncementEditButton } from '@/components/comms/announcement-composer';
import { CommandButton } from '@/components/confirm-button';
import { deleteAnnouncementAction, pinAnnouncementAction } from '@/server/actions/announcements';

export interface AnnouncementView {
  id: string;
  courseId: string | null;
  title: string;
  contentHtml: string;
  pinned: boolean;
  notify: boolean;
  publishAt: Date;
  groupId: string | null;
  author: { name: string; image: string | null } | null;
  group: { name: string } | null;
  course?: { id: string; fullName: string } | null;
}

export async function AnnouncementList({
  items,
  canManage,
  groups,
  emptyText,
  compact,
}: {
  items: AnnouncementView[];
  canManage: boolean;
  /** The course's groups, for an announcement edited to one of them. */
  groups?: { id: string; name: string }[];
  emptyText?: string;
  compact?: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations('announcements'), getFormatter()]);
  const now = new Date();
  if (!items.length)
    return emptyText ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null;
  return (
    <ul className="grid gap-3">
      {items.map((a) => (
        <li key={a.id} id={`a-${a.id}`} className="scroll-mt-20">
          <article
            aria-labelledby={`at-${a.id}`}
            className="grid gap-3 rounded-lg border border-border bg-card p-4"
          >
            <header className="flex flex-wrap items-center gap-2">
              {a.author ? <Avatar name={a.author.name} src={a.author.image} size={32} /> : null}
              <div className="grid min-w-0 flex-1">
                <h3 id={`at-${a.id}`} className="font-semibold">
                  {a.course ? `${a.course.fullName}: ` : ''}
                  {a.title}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {a.author ? `${a.author.name} · ` : ''}
                  <time dateTime={a.publishAt.toISOString()}>
                    {format.dateTime(a.publishAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </time>
                </span>
              </div>
              {a.pinned ? <Badge variant="accent">{t('pinned')}</Badge> : null}
              {a.publishAt > now ? (
                <Badge variant="warning">
                  {t('scheduled', {
                    date: format.dateTime(a.publishAt, { dateStyle: 'short', timeStyle: 'short' }),
                  })}
                </Badge>
              ) : null}
              {a.group ? <Badge>{a.group.name}</Badge> : null}
              {canManage ? (
                <div className="flex gap-1">
                  <AnnouncementEditButton
                    courseId={a.courseId}
                    groups={groups}
                    announcement={{
                      id: a.id,
                      title: a.title,
                      contentHtml: a.contentHtml,
                      publishAt: a.publishAt.toISOString(),
                      groupId: a.groupId,
                      pinned: a.pinned,
                      notify: a.notify,
                    }}
                  />
                  <CommandButton
                    size="icon"
                    variant="ghost"
                    aria-label={a.pinned ? t('unpin') : t('pin')}
                    run={pinAnnouncementAction.bind(null, a.id, !a.pinned, a.courseId)}
                  >
                    {a.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                  </CommandButton>
                  <CommandButton
                    size="icon"
                    variant="ghost"
                    aria-label={t('delete')}
                    confirm={t('deleteConfirm')}
                    run={deleteAnnouncementAction.bind(null, a.id, a.courseId)}
                  >
                    <Trash2 aria-hidden />
                  </CommandButton>
                </div>
              ) : null}
            </header>
            {a.contentHtml ? (
              <RichText html={a.contentHtml} className={compact ? 'line-clamp-4 text-sm' : ''} />
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
