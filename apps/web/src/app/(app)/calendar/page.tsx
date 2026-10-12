import { listUserEvents } from '@hubium/core';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteEventAction } from '@/server/actions/calendar';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';
import { FeedLink, NewEventForm } from './calendar-parts';

function monthStart(y: number, m: number) {
  return new Date(Date.UTC(y, m, 1));
}

export async function generateMetadata() {
  return { title: (await getTranslations('calendar'))('title') };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; view?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const [t, format, locale] = await Promise.all([
    getTranslations('calendar'),
    getFormatter(),
    getLocale(),
  ]);
  const now = new Date();
  const [y, m] = /^\d{4}-\d{2}$/.test(sp.m ?? '')
    ? sp.m!.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const start = monthStart(y!, m! - 1);
  const end = monthStart(y!, m!);
  const view = sp.view === 'agenda' ? 'agenda' : 'month';
  const events = await listUserEvents(
    db,
    user.id,
    view === 'agenda'
      ? { from: now, to: new Date(now.getTime() + 60 * 86_400_000) }
      : { from: start, to: end },
  );
  const prev = new Date(Date.UTC(y!, m! - 2, 1));
  const next = new Date(Date.UTC(y!, m!, 1));
  const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  // Monday-first grid
  const firstDow = (start.getUTCDay() + 6) % 7;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const cells = Array.from({ length: Math.ceil((firstDow + days) / 7) * 7 }, (_, i) => {
    const day = i - firstDow + 1;
    return day >= 1 && day <= days ? new Date(Date.UTC(y!, m! - 1, day)) : null;
  });
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, 1 + i)),
    ),
  );
  const ctx = await getContext();
  const courses = await db.course.findMany({
    where: { deletedAt: null, enrolments: { some: { userId: user.id } } },
    select: { id: true, fullName: true },
  });
  const manageable = [];
  for (const c of courses)
    if (await ctx.perm.can('calendar:managecourse', c.id)) manageable.push(c);
  const canSite = await ctx.perm.can('calendar:managesite');
  const sameDay = (a: Date, b: Date) =>
    a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  const today = new Date();
  return (
    <>
      <PageHeader
        title={t('title')}
        actions={
          <div className="flex gap-1">
            <Button asChild size="sm" variant={view === 'month' ? 'secondary' : 'ghost'}>
              <Link href="/calendar">{t('month')}</Link>
            </Button>
            <Button asChild size="sm" variant={view === 'agenda' ? 'secondary' : 'ghost'}>
              <Link href="/calendar?view=agenda">{t('agenda')}</Link>
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div>
          {view === 'month' ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Button asChild size="icon" variant="ghost" aria-label={t('prev')}>
                  <Link href={`/calendar?m=${key(prev)}`}>
                    <ChevronLeft />
                  </Link>
                </Button>
                <h2 className="min-w-44 text-center text-lg font-semibold capitalize">
                  {new Intl.DateTimeFormat(locale, {
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  }).format(start)}
                </h2>
                <Button asChild size="icon" variant="ghost" aria-label={t('next')}>
                  <Link href={`/calendar?m=${key(next)}`}>
                    <ChevronRight />
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/calendar">{t('today')}</Link>
                </Button>
              </div>
              <table className="hidden w-full table-fixed border-collapse md:table">
                <thead>
                  <tr>
                    {weekdays.map((w) => (
                      <th
                        key={w}
                        scope="col"
                        className="border border-border bg-surface px-2 py-1 text-left text-xs font-medium text-muted-foreground"
                      >
                        {w}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: cells.length / 7 }, (_, w) =>
                    cells.slice(w * 7, w * 7 + 7),
                  ).map((week, w) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid position
                    <tr key={w}>
                      {week.map((d, i) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid position
                          key={i}
                          className={cn(
                            'h-24 border border-border bg-card p-1.5 align-top text-xs',
                            !d && 'bg-surface',
                          )}
                        >
                          {d ? (
                            <>
                              <span
                                className={cn(
                                  'inline-flex size-6 items-center justify-center rounded-full',
                                  sameDay(d, today) && 'bg-accent text-accent-foreground',
                                )}
                              >
                                {d.getUTCDate()}
                              </span>
                              <ul className="mt-1 grid gap-1">
                                {events
                                  .filter((e) => sameDay(e.startsAt, d))
                                  .map((e) => (
                                    <li
                                      key={e.id}
                                      className="truncate rounded bg-accent-soft px-1 py-0.5 text-accent"
                                      title={e.title}
                                    >
                                      {e.activityId && e.courseId ? (
                                        <Link href={`/course/${e.courseId}/a/${e.activityId}`}>
                                          {e.title}
                                        </Link>
                                      ) : (
                                        e.title
                                      )}
                                    </li>
                                  ))}
                              </ul>
                            </>
                          ) : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          <ul className={cn('grid gap-2', view === 'month' && 'mt-4 md:hidden')}>
            {events.length === 0 ? (
              <li className="text-sm text-muted-foreground">{t('noEvents')}</li>
            ) : null}
            {events.map((e) => (
              <li key={e.id}>
                <Card>
                  <CardContent className="flex items-start justify-between gap-3 pt-4">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {e.activityId && e.courseId ? (
                          <Link
                            href={`/course/${e.courseId}/a/${e.activityId}`}
                            className="hover:underline"
                          >
                            {e.title}
                          </Link>
                        ) : (
                          e.title
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format.dateTime(
                          e.startsAt,
                          e.allDay
                            ? { dateStyle: 'full' }
                            : { dateStyle: 'full', timeStyle: 'short' },
                        )}
                        {e.courseName ? ` · ${e.courseName}` : ''}
                      </p>
                      {e.description ? <p className="mt-1 text-sm">{e.description}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge>{t(`kinds.${e.kind}`)}</Badge>
                      {!e.activityId && (e.userId === user.id || canSite) ? (
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          confirm={t('deleteConfirm')}
                          run={deleteEventAction.bind(null, e.id)}
                        >
                          ×
                        </CommandButton>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('newEvent')}</CardTitle>
            </CardHeader>
            <CardContent>
              <NewEventForm courses={manageable} canSite={canSite} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('feed')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FeedLink baseUrl={process.env.APP_URL ?? ''} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
